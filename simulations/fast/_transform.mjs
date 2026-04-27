// One-off transform: copies simul-jing-loan-*.js / simul-loan-snpl-*.js into
// simulations/fast/ with skip_tracing enabled and verification wired in.
// Idempotent: re-run safely if README adds new scripts.
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("simulations");
const DST = path.resolve("simulations/fast");

const PATTERNS = [/^simul-jing-loan-.+\.js$/, /^simul-loan-snpl-.+\.js$/];

const files = fs
  .readdirSync(SRC)
  .filter((f) => PATTERNS.some((re) => re.test(f)))
  .sort();

console.log(`Transforming ${files.length} script(s) into ${DST}/`);

for (const f of files) {
  const srcPath = path.join(SRC, f);
  let code = fs.readFileSync(srcPath, "utf8");

  const label = f
    .replace(/^simul-/, "")
    .replace(/\.js$/, "")
    .replace(/-/g, " ")
    .toUpperCase();

  // 1) Add verifier + expectations + block-pins imports right after stxer.
  code = code.replace(
    /import \{ SimulationBuilder \} from "stxer";\n/,
    `import { SimulationBuilder } from "stxer";\nimport { verifyAndReport } from "./_verify.js";\nimport { expectations } from "./_expectations.js";\nimport { blockPins } from "./_block-pins.js";\n`
  );

  // 2) Enable skip_tracing AND pin to the README's historical block height
  //    (so verifier tests contract behavior, not current chain balances).
  const scriptKeyForPin = f.replace(/\.js$/, "");
  code = code.replace(
    /SimulationBuilder\.new\(\)/,
    `SimulationBuilder.new({ skipTracing: true })\n    .useBlockHeight(blockPins[${JSON.stringify(scriptKeyForPin)}].block_height)`
  );

  // 3) Replace the two trailing console.log lines with a verifier call.
  const scriptKey = f.replace(/\.js$/, "");
  code = code.replace(
    /  console\.log\(`\\nSimulation submitted!`\);\n  console\.log\(`View results: https:\/\/stxer\.xyz\/simulations\/mainnet\/\$\{sessionId\}`\);\n/,
    `  console.log(\`\\nSession: \${sessionId}\`);\n  const _verify = await verifyAndReport(sessionId, ${JSON.stringify(label)}, expectations[${JSON.stringify(scriptKey)}] || {});\n  if (!_verify.passed) process.exit(1);\n`
  );

  // 4) Make the top-level catch exit non-zero so the runner can detect failures.
  code = code.replace(
    /main\(\)\.catch\(console\.error\);/,
    `main().catch((e) => { console.error(e); process.exit(1); });`
  );

  fs.writeFileSync(path.join(DST, f), code);
  console.log(`  ${f}  →  fast/${f}`);
}

console.log("Done.");
