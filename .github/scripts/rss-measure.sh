#!/usr/bin/env bash
# Runs the two heavy apps/api tsc projects in the same order and with the same
# heap cap as CI, recording peak RSS for each.
set -uo pipefail

variant="${1:?variant required}"
out_dir="${RUNNER_TEMP:-/tmp}/rss"
mkdir -p "$out_dir"

cd turbo

echo "--- building dependency declarations (no-op on base)"
pnpm --filter @vm0/pi-agent-runtime run build || true
if [ -f packages/pi-agent-runtime/dist/index.d.ts ]; then
  echo "--- emitted dist/index.d.ts:"
  cat packages/pi-agent-runtime/dist/index.d.ts
  echo "--- third-party references in emitted declarations:"
  grep -rn "@earendil-works" packages/pi-agent-runtime/dist/index.d.ts packages/pi-agent-runtime/dist/node.d.ts packages/pi-agent-runtime/dist/types.d.ts || echo "NONE (good)"
fi

cd apps/api

echo "--- resolution probe: which files back @vm0/pi-agent-runtime"
mkdir -p .rss-probe
cat >.rss-probe/probe.ts <<'TS'
import type { PiAgentMessage } from "@vm0/pi-agent-runtime";
import { parsePiAgentMessages } from "@vm0/pi-agent-runtime";

export const probe: PiAgentMessage[] = parsePiAgentMessages([]);
TS
cat >.rss-probe/tsconfig.json <<'JSON'
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "noEmit": true, "incremental": false },
  "include": ["probe.ts"]
}
JSON
pnpm exec tsc -p .rss-probe/tsconfig.json --listFiles >"$out_dir/probe.txt" 2>&1 || true
echo "pi-agent-runtime files in probe program:"
grep -E "pi-agent-runtime/(src|dist)" "$out_dir/probe.txt" || true
echo "earendil files in probe program: $(grep -c earendil "$out_dir/probe.txt" || true)"
rm -rf .rss-probe


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
  echo "--- first tsc diagnostics for $label:"
  head -30 "$log"
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

measure core -p tsconfig.core.json
measure tests -p tsconfig.tests.json --noEmit
