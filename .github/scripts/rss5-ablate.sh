#!/usr/bin/env bash
# Round 5 ablation harness for apps/api check-types peak RSS, run on top of the
# post-boundary main (pi-agent-runtime .d.ts, gateways project, no DOM lib).
#
# Two families of variants:
#   stub-*  collapse a third-party package's .d.ts to `export {}` (type errors
#           are expected and irrelevant; only peak RSS is measured)
#   dts-*   give an internal source-exported workspace package a real .d.ts
#           surface and repoint its package.json `types` at it, the same move
#           #25711 made for @vm0/pi-agent-runtime
set -euo pipefail

variant="${1:?variant required}"

stub_pkg() {
  local pkg="$1"
  local n=0 bytes=0 d f size
  for d in turbo/node_modules/.pnpm/*/node_modules/"$pkg"; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      size=$(stat -c %s "$f")
      bytes=$((bytes + size))
      printf 'export {};\n' >"$f"
      n=$((n + 1))
    done < <(find "$d" \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \))
  done
  echo "DTS pkg=$pkg files=$n bytes=$bytes"
  [ "$n" -gt 0 ] || echo "WARNING: nothing stubbed for $pkg" >&2
}

stub_glob() {
  local glob="$1"
  local n=0 bytes=0 d f size
  for d in turbo/node_modules/.pnpm/*/node_modules/$glob; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      size=$(stat -c %s "$f")
      bytes=$((bytes + size))
      printf 'export {};\n' >"$f"
      n=$((n + 1))
    done < <(find "$d" \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \))
  done
  echo "DTS glob=$glob files=$n bytes=$bytes"
  [ "$n" -gt 0 ] || echo "WARNING: nothing stubbed for $glob" >&2
}

# Emit declarations for a source-exported workspace package and repoint every
# `types` condition in its exports map at the emitted .d.ts.
emit_dts() {
  local pkg_dir="turbo/packages/$1"
  echo "--- emitting declarations for $pkg_dir"
  (
    cd "$pkg_dir"
    cat >tsconfig.dts.json <<'JSON'
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationMap": false,
    "emitDeclarationOnly": true,
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/__tests__/**/*", "src/**/*.test.ts"]
}
JSON
    set +e
    pnpm exec tsc -p tsconfig.dts.json >/tmp/dts-$1.log 2>&1
    local code=$?
    set -e
    local errs
    errs=$(grep -c "error TS" "/tmp/dts-$1.log" || true)
    local emitted
    emitted=$(find dist -name '*.d.ts' 2>/dev/null | wc -l)
    echo "DTS-EMIT pkg=$1 exitCode=$code tsErrors=$errs emittedDts=$emitted"
    echo "--- first 15 declaration-emit diagnostics [$1]"
    grep "error TS" "/tmp/dts-$1.log" | head -15 || true
    node -e '
      const fs = require("node:fs");
      const json = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const repoint = (node) => {
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === "string") {
            if (key === "types") {
              node[key] = value.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".d.ts");
            }
            continue;
          }
          repoint(value);
        }
      };
      repoint(json.exports);
      fs.writeFileSync("package.json", JSON.stringify(json, null, 2) + "\n");
      console.log("repointed exports:", JSON.stringify(json.exports));
    '
  )
}

case "$variant" in
  head-a | head-b | head-c) ;;
  stub-stripe) stub_pkg "stripe" ;;
  stub-clerk) stub_glob "@clerk/*" ;;
  stub-slack) stub_glob "@slack/*" ;;
  stub-aws)
    stub_glob "@aws-sdk/*"
    stub_glob "@smithy/*"
    ;;
  stub-pi) stub_glob "@earendil-works/*" ;;
  stub-zod) stub_pkg "zod" ;;
  stub-drizzle) stub_pkg "drizzle-orm" ;;
  stub-ccstate) stub_pkg "ccstate" ;;
  stub-all-sdks)
    stub_pkg "stripe"
    stub_glob "@clerk/*"
    stub_glob "@slack/*"
    stub_glob "@aws-sdk/*"
    stub_glob "@smithy/*"
    stub_glob "@sentry/*"
    stub_glob "@sentry-internal/*"
    stub_glob "@opentelemetry/*"
    stub_glob "@vercel/otel"
    stub_glob "@team-plain/*"
    stub_pkg "ably"
    stub_pkg "svix"
    stub_pkg "google-auth-library"
    stub_pkg "music-metadata"
    stub_pkg "gpt-tokenizer"
    stub_pkg "resend"
    stub_pkg "archiver"
    stub_pkg "tar"
    stub_pkg "web-push"
    stub_pkg "html-to-text"
    stub_pkg "croner"
    stub_pkg "uuid"
    stub_pkg "pg"
    stub_pkg "@types/pg"
    stub_pkg "signal-timers"
    stub_pkg "@t3-oss/env-core"
    ;;
  dts-db) emit_dts db ;;
  dts-core) emit_dts core ;;
  dts-api-contracts) emit_dts api-contracts ;;
  dts-all-internal)
    emit_dts db
    emit_dts core
    emit_dts api-contracts
    ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 1
    ;;
esac

echo "--- ablation [$variant] applied"
