#!/usr/bin/env bash
# Runs each project of the apps/api check-types chain under CI's heap cap and
# records per-project peak RSS. Steps are not && chained: an ablation variant is
# expected to make some of them exit non-zero, and later projects are still
# worth measuring (with the caveat that a project reading an upstream project's
# incomplete .d.ts reports an understated number).
set -uo pipefail

variant="${1:?variant required}"
out_dir="${RUNNER_TEMP:-/tmp}/rss5"
mkdir -p "$out_dir"

measure() {
  local project="$1"
  shift
  local json="$out_dir/$project.jsonl"
  local log="$out_dir/$project.log"
  rm -f "$json"

  NODE_OPTIONS=--max-old-space-size=3072 \
    node ../../scripts/measure-memory.mjs \
    --label "$project" \
    --json "$json" \
    -- "$@" >"$log" 2>&1

  local errors
  errors=$(grep -c "error TS" "$log" || true)
  echo "--- first 15 diagnostics [$variant/$project]"
  grep "error TS" "$log" | head -15 || true
  node -e '
    const fs = require("node:fs");
    const [file, variant, project, errors] = process.argv.slice(1);
    if (!fs.existsSync(file)) {
      console.log(`RESULT variant=${variant} project=${project} peakRssMiB=NA`);
      process.exit(0);
    }
    const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean);
    const r = JSON.parse(lines[lines.length - 1]);
    console.log(
      `RESULT variant=${variant} project=${project} peakRssMiB=${r.peakRssMiB} durationMs=${r.durationMs} exitCode=${r.exitCode} tsErrors=${errors}`,
    );
  ' "$json" "$variant" "$project" "$errors"
}

# pi-agent-runtime publishes a real .d.ts surface; the chain builds it first.
pnpm --filter @vm0/pi-agent-runtime run build >"$out_dir/deps.log" 2>&1
echo "--- deps build exit=$?"

measure gateways pnpm exec tsc -p tsconfig.gateways.json
measure core pnpm exec tsc -p tsconfig.core.json
measure bootstrap pnpm exec tsc -p tsconfig.bootstrap.json
measure tests pnpm exec tsc -p tsconfig.tests.json --noEmit
measure bootstrap-wiring pnpm exec tsc -p tsconfig.bootstrap-wiring.json --noEmit
