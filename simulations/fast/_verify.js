// _verify.js — shared helper for fast (skip_tracing) loan/loan-snpl simulations.
// Fetches the simulation summary from stxer's GET endpoint, decodes each step's
// Clarity result, and (when expectations are provided) checks whether the
// contract's actual behavior matches what the README says it should be.

const STXER_API = "https://api.stxer.xyz";

// Decode a Clarity-serialized hex string into a README-style readable form.
// Returns "(ok u1)", "u22000000", "(err u100)", "(some u1)", "none", "true",
// "false", or null for types we don't try to render strictly (tuples, lists,
// principals, buffers, strings).
export function decodeClarity(hex) {
  if (typeof hex !== "string" || hex.length < 2) return null;
  const h = hex.toLowerCase();
  const tag = h.slice(0, 2);

  if (tag === "03") return "true";
  if (tag === "04") return "false";
  if (tag === "09") return "none";

  if (tag === "01" && h.length === 34) {
    try {
      return `u${BigInt("0x" + h.slice(2)).toString()}`;
    } catch {
      return null;
    }
  }

  if (tag === "07" || tag === "08") {
    const inner = decodeClarity(h.slice(2));
    if (inner === null) return null;
    return `(${tag === "07" ? "ok" : "err"} ${inner})`;
  }

  if (tag === "0a") {
    const inner = decodeClarity(h.slice(2));
    if (inner === null) return null;
    return `(some ${inner})`;
  }

  return null; // tuple/list/principal/buffer/string — caller falls back
}

async function fetchSummary(sessionId) {
  const url = `${STXER_API}/devtools/v2/simulations/${sessionId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Decode the leading type byte of a Clarity-serialized hex result.
// 0x07 = (ok ...), 0x08 = (err ...). We treat 0x08 as a contract-level
// error (distinct from a VM crash) so we can report it without a hard fail.
function clarityResponseKind(hex) {
  if (typeof hex !== "string" || hex.length < 2) return null;
  const tag = hex.slice(0, 2).toLowerCase();
  if (tag === "07") return "ok";
  if (tag === "08") return "err";
  return null;
}

function classifyStep(step) {
  if (step.Result?.Transaction) {
    const txr = step.Result.Transaction;
    if ("Ok" in txr) {
      const r = txr.Ok;
      // Hard-fail on VM crash or post-condition abort.
      if (r.vm_error) return { kind: "Tx", ok: false, result: r.result, error: `vm_error: ${r.vm_error}` };
      if (r.post_condition_aborted) return { kind: "Tx", ok: false, result: r.result, error: "post_condition_aborted" };
      // Contract returned (err ...) — flag separately, don't crash the run.
      if (clarityResponseKind(r.result) === "err") {
        return { kind: "Tx", ok: false, contractErr: true, result: r.result, error: `contract returned (err): ${r.result}` };
      }
      return { kind: "Tx", ok: true, result: r.result, txid: step.TxId };
    }
    return { kind: "Tx", ok: false, error: txr.Err };
  }
  if (step.Result?.Eval) {
    const ev = step.Result.Eval;
    if ("Ok" in ev) return { kind: "Eval", ok: true, result: ev.Ok };
    return { kind: "Eval", ok: false, error: ev.Err };
  }
  if (step.Result?.SetContractCode) {
    const sc = step.Result.SetContractCode;
    if ("Err" in sc) return { kind: "SetCode", ok: false, error: sc.Err };
    return { kind: "SetCode", ok: true, result: "deployed" };
  }
  if (step.Result?.Reads) {
    const reads = step.Result.Reads;
    const errs = reads.map((r, j) => ("Err" in r ? `read[${j}]: ${r.Err}` : null)).filter(Boolean);
    if (errs.length) return { kind: "Reads", ok: false, error: errs.join("; ") };
    return { kind: "Reads", ok: true, result: `${reads.length} read(s) ok` };
  }
  if (step.Result?.TenureExtend) return { kind: "TenureExtend", ok: true, result: "tenure extended" };
  return { kind: "Unknown", ok: false, error: JSON.stringify(step.Result).slice(0, 120) };
}

function truncate(s, n = 120) {
  if (typeof s !== "string") return String(s);
  return s.length > n ? s.slice(0, n) + "..." : s;
}

// Compare a step's actual outcome against the README expectation string.
// `expected` is a string like "(ok u1)", "u100", "(err u100)", "(some u1)",
// "none", "true", "false", or "Success" (deploys). Anything else is treated
// as "no strict expectation, only check that the step didn't hard-fail".
function matchesExpectation(c, expected) {
  if (!expected) return { match: true, reason: null };

  if (/^Success$/i.test(expected)) {
    // Deploy step — pass as long as it's a Tx that didn't hard-fail.
    if (c.kind === "Tx" && !c.contractErr) return { match: true, reason: null };
    return { match: false, reason: `expected Success, got ${c.contractErr ? "(err)" : c.error || "non-Tx"}` };
  }

  // Decode actual result for comparison.
  const actual = decodeClarity(c.result);
  if (actual === null) {
    return { match: false, reason: `expected ${expected}, but actual hex ${c.result?.slice(0, 40)}... is not strictly comparable` };
  }
  if (actual !== expected) {
    return { match: false, reason: `expected ${expected}, got ${actual}` };
  }
  return { match: true, reason: null };
}

export async function verifyAndReport(sessionId, label, expectations = {}) {
  const summary = await fetchSummary(sessionId);
  const classified = summary.steps.map((s, i) => ({ idx: i, ...classifyStep(s) }));

  // Hard failures = VM crashes, post-condition aborts, eval/read/setcode errors.
  const hardFails = classified.filter((c) => !c.ok && !c.contractErr);

  // Walk expectations and find mismatches.
  const expectedKeys = Object.keys(expectations).map((k) => parseInt(k, 10));
  const mismatches = [];
  for (const i of expectedKeys) {
    const c = classified[i];
    if (!c) {
      mismatches.push({ idx: i, expected: expectations[i], reason: "no such step in summary" });
      continue;
    }
    const m = matchesExpectation(c, expectations[i]);
    if (!m.match) mismatches.push({ idx: i, expected: expectations[i], reason: m.reason });
  }

  // Contract errors that have NO matching expectation are still suspicious.
  const unexpectedContractErrs = classified.filter(
    (c) => c.contractErr && !(c.idx in expectations)
  );

  console.log(`\n--- VERIFY: ${label} ---`);
  console.log(`Session:        ${sessionId}`);
  console.log(`Block height:   ${summary.metadata.block_height}`);
  console.log(`skip_tracing:   ${summary.metadata.skip_tracing}`);
  console.log(
    `Steps:          ${classified.length}, expectations: ${expectedKeys.length} encoded, ${mismatches.length} mismatch, ${hardFails.length} hard-fail, ${unexpectedContractErrs.length} unexpected (err)`
  );

  for (const c of classified) {
    const exp = expectations[c.idx];
    let tag;
    if (!c.ok && !c.contractErr) tag = "FAIL";
    else if (mismatches.find((m) => m.idx === c.idx)) tag = "DIFF";
    else if (exp) tag = "OK✓ ";
    else if (c.contractErr) tag = "CERR";
    else tag = "OK  ";

    const decoded = decodeClarity(c.result);
    const body = c.ok || c.contractErr
      ? `${decoded || truncate(c.result)}${exp ? `   [exp: ${exp}]` : ""}`
      : `(${c.kind}) ${c.error}`;
    console.log(`  [${String(c.idx).padStart(2)}] ${tag} ${c.kind.padEnd(7)} ${body}`);
  }

  // PASS only when no hard fails AND no expectation mismatches.
  // CERRs without expectations are noted but don't fail (could be expected guards
  // in scripts whose READMEs we haven't fully encoded yet).
  const passed = hardFails.length === 0 && mismatches.length === 0;

  if (mismatches.length > 0) {
    console.log("Mismatches:");
    for (const m of mismatches) console.log(`  step ${m.idx}: ${m.reason}`);
  }

  if (passed && expectedKeys.length > 0) {
    console.log(`RESULT: PASS — ${label} (${expectedKeys.length}/${expectedKeys.length} expectations met)`);
  } else if (passed) {
    console.log(`RESULT: PASS — ${label} (no expectations encoded, engine-level only)`);
  } else if (hardFails.length > 0) {
    console.log(`RESULT: FAIL — ${label} (${hardFails.length} hard fail(s))`);
  } else {
    console.log(`RESULT: FAIL — ${label} (${mismatches.length} expectation mismatch(es))`);
  }
  return { passed, sessionId, classified, hardFails, mismatches, unexpectedContractErrs };
}
