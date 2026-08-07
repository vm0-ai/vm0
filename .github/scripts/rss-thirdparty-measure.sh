#!/usr/bin/env bash
# Runs the apps/api core tsc project with CI's heap cap and records peak RSS.
# Only tsconfig.core.json is measured: it is where CI's peak comes from, and the
# tests project consumes core's emitted .d.ts, which is incomplete whenever an
# ablation variant makes core exit with errors.
set -uo pipefail

variant="${1:?variant required}"
out_dir="${RUNNER_TEMP:-/tmp}/rss"
mkdir -p "$out_dir"

json="$out_dir/core.jsonl"
log="$out_dir/core.log"
rm -f "$json"

NODE_OPTIONS=--max-old-space-size=3072 \
  node ../../scripts/measure-memory.mjs \
  --label core \
  --json "$json" \
  -- pnpm exec tsc -p tsconfig.core.json >"$log" 2>&1

errors=$(grep -c "error TS" "$log" || true)
node -e '
  const fs = require("node:fs");
  const [file, variant, errors] = process.argv.slice(1);
  if (!fs.existsSync(file)) {
    console.log(`RESULT variant=${variant} project=core peakRssMiB=NA`);
    process.exit(0);
  }
  const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean);
  const r = JSON.parse(lines[lines.length - 1]);
  console.log(
    `RESULT variant=${variant} project=core peakRssMiB=${r.peakRssMiB} durationMs=${r.durationMs} exitCode=${r.exitCode} tsErrors=${errors}`,
  );
' "$json" "$variant" "$errors"
