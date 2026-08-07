#!/usr/bin/env bash
# Measures the "floor" cost of each third-party declaration surface: a program
# containing nothing but one import of the package, compiled with apps/api's own
# compiler options. The delta against the empty baseline is what tsc spends just
# parsing/binding the package's .d.ts files, before any of api's own code
# instantiates anything from them.
set -uo pipefail

cd turbo/apps/api
mkdir -p probe
cat >probe/tsconfig.json <<'JSON'
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "incremental": true,
    "tsBuildInfoFile": "./.probe.tsbuildinfo"
  },
  "include": ["index.ts"]
}
JSON

measure_probe() {
  local label="$1" source="$2"
  printf '%s\n' "$source" >probe/index.ts
  local json="/tmp/floor-${label//[^a-zA-Z0-9]/_}.jsonl"
  rm -f "$json" probe/.probe.tsbuildinfo
  NODE_OPTIONS=--max-old-space-size=3072 \
    node ../../scripts/measure-memory.mjs --label "$label" --json "$json" \
    -- pnpm exec tsc -p probe/tsconfig.json >/tmp/floor.log 2>&1
  node -e '
    const fs = require("node:fs");
    const [file, label] = process.argv.slice(1);
    if (!fs.existsSync(file)) { console.log(`FLOOR pkg=${label} peakRssMiB=NA`); process.exit(0); }
    const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean);
    const r = JSON.parse(lines[lines.length - 1]);
    console.log(`FLOOR pkg=${label} peakRssMiB=${r.peakRssMiB} durationMs=${r.durationMs}`);
  ' "$json" "$label"
}

measure_probe "__empty__" "export {};"
for pkg in stripe @clerk/backend @slack/web-api @aws-sdk/client-s3 @aws-sdk/client-kms \
  @sentry/node @opentelemetry/api drizzle-orm zod ccstate hono ably svix \
  gpt-tokenizer google-auth-library music-metadata resend @team-plain/typescript-sdk; do
  measure_probe "$pkg" "import * as P from \"$pkg\"; export type T = typeof P;"
done
