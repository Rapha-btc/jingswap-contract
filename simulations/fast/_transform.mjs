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

  // 1) Add verifier + expectations imports right after the stxer import.
  code = code.replace(
    /import \{ SimulationBuilder \} from "stxer";\n/,
    `import { SimulationBuilder } from "stxer";\nimport { verifyAndReport } from "./_verify.js";\nimport { expectations } from "./_expectations.js";\n`
  );

  // 2) Enable skip_tracing on the builder.
  code = code.replace(
    /SimulationBuilder\.new\(\)/,
    "SimulationBuilder.new({ skipTracing: true })"
  );

  // 3) Replace the two trailing console.log lines with a verifier call.
  code = code.replace(
    /  console\.log\(`\\nSimulation submitted!`\);\n  console\.log\(`View results: https:\/\/stxer\.xyz\/simulations\/mainnet\/\$\{sessionId\}`\);\n/,
    `  console.log(\`\\nSession: \${sessionId}\`);\n  const _verify = await verifyAndReport(sessionId, ${JSON.stringify(label)});\n  if (!_verify.passed) process.exit(1);\n`
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
