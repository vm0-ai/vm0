#!/usr/bin/env bash
# Measures the round-6 probe project's peak RSS plus tsc's own type-count
# diagnostics, under CI's heap cap.
set -uo pipefail

variant="${1:?variant required}"
out_dir="${RUNNER_TEMP:-/tmp}/rss6"
mkdir -p "$out_dir"

# gateways emits the .d.ts the probe program reads through project references.
pnpm --filter @vm0/pi-agent-runtime run build >"$out_dir/deps.log" 2>&1
echo "--- deps build exit=$?"
pnpm exec tsc -p tsconfig.gateways.json >"$out_dir/gateways.log" 2>&1
echo "--- gateways build exit=$?"

json="$out_dir/probe.jsonl"
log="$out_dir/probe.log"

NODE_OPTIONS=--max-old-space-size=3072 \
  node ../../scripts/measure-memory.mjs \
  --label probe \
  --json "$json" \
  -- pnpm exec tsc -p tsconfig.probe.json --extendedDiagnostics >"$log" 2>&1

errors=$(grep -c "error TS" "$log" || true)
echo "--- extendedDiagnostics [$variant]"
grep -E "^(Files|Lines|Identifiers|Symbols|Types|Instantiations|Memory used|Total time|Check time|Program time):" "$log" || true
echo "--- first 10 diagnostics [$variant]"
grep "error TS" "$log" | head -10 || true

node -e '
  const fs = require("node:fs");
  const [file, variant, errors] = process.argv.slice(1);
  if (!fs.existsSync(file)) {
    console.log(`RESULT variant=${variant} peakRssMiB=NA`);
    process.exit(0);
  }
  const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean);
  const r = JSON.parse(lines[lines.length - 1]);
  console.log(
    `RESULT variant=${variant} peakRssMiB=${r.peakRssMiB} durationMs=${r.durationMs} exitCode=${r.exitCode} tsErrors=${errors}`,
  );
' "$json" "$variant" "$errors"
