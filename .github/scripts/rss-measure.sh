#!/usr/bin/env bash
# Runs the two heavy apps/api tsc projects in the same order and with the same
# heap cap as CI, recording peak RSS for each.
set -uo pipefail

variant="${1:?variant required}"
out_dir="${RUNNER_TEMP:-/tmp}/rss"
mkdir -p "$out_dir"

measure() {
  local label="$1"
  shift
  local json="$out_dir/$label.jsonl"
  local log="$out_dir/$label.log"
  rm -f "$json"

  NODE_OPTIONS=--max-old-space-size=3072 \
    node ../../scripts/measure-memory.mjs \
    --label "$label" \
    --json "$json" \
    -- pnpm exec tsc "$@" >"$log" 2>&1

  local errors
  errors=$(grep -c "error TS" "$log" || true)
  node -e '
    const fs = require("node:fs");
    const [file, variant, label, errors] = process.argv.slice(1);
    if (!fs.existsSync(file)) {
      console.log(`RESULT variant=${variant} project=${label} peakRssMiB=NA`);
      process.exit(0);
    }
    const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean);
    const r = JSON.parse(lines[lines.length - 1]);
    console.log(
      `RESULT variant=${variant} project=${label} peakRssMiB=${r.peakRssMiB} durationMs=${r.durationMs} exitCode=${r.exitCode} tsErrors=${errors}`,
    );
  ' "$json" "$variant" "$label" "$errors"
}

# core emits declarations that the tests project consumes, so keep CI's order.
measure core -p tsconfig.core.json
measure tests -p tsconfig.tests.json --noEmit
