#!/usr/bin/env bash
# Ablation harness for attributing the apps/api check-types peak RSS to the
# third-party type surfaces reachable from api's program. Each variant collapses
# one library's declaration files to `export {}` and lets tsc run; type errors
# are expected and irrelevant -- only peak RSS is being measured.
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
  # stub every pnpm-installed package whose directory matches the given glob,
  # e.g. "@aws-sdk/*" or "@opentelemetry/*"
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

count_glob() {
  local glob="$1"
  local n=0 bytes=0 d f size
  for d in turbo/node_modules/.pnpm/*/node_modules/$glob; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      size=$(stat -c %s "$f")
      bytes=$((bytes + size))
      n=$((n + 1))
    done < <(find "$d" \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \))
  done
  echo "DTS-INVENTORY glob=$glob files=$n bytes=$bytes"
}

patch_tsconfig() {
  # Applies a mutation to apps/api/tsconfig.json's compilerOptions. The core /
  # bootstrap / tests projects all extend it, so this changes every api program.
  local mutation="$1"
  node -e '
    const fs = require("node:fs");
    const path = "turbo/apps/api/tsconfig.json";
    const raw = fs.readFileSync(path, "utf8");
    const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    const c = json.compilerOptions;
    '"$mutation"'
    fs.writeFileSync(path, JSON.stringify(json, null, 2));
    console.log("patched tsconfig:", JSON.stringify(c));
  '
}

case "$variant" in
  head)
    # no stubbing; just record the declaration surface of every candidate
    for g in stripe "@clerk/*" "@slack/*" "@aws-sdk/*" "@smithy/*" drizzle-orm \
      zod hono "@hono/*" "@opentelemetry/*" "@sentry/*" "@team-plain/*" ably \
      ccstate svix google-auth-library music-metadata gpt-tokenizer resend \
      archiver tar web-push html-to-text croner uuid pg "@types/node" msw vitest \
      "@modelcontextprotocol/*" "@earendil-works/*"; do
      count_glob "$g"
    done
    ;;
  stub-stripe)
    stub_pkg "stripe"
    ;;
  stub-clerk)
    stub_glob "@clerk/*"
    ;;
  stub-slack)
    stub_glob "@slack/*"
    ;;
  stub-aws)
    stub_glob "@aws-sdk/*"
    stub_glob "@smithy/*"
    ;;
  stub-drizzle)
    stub_pkg "drizzle-orm"
    ;;
  stub-zod)
    stub_pkg "zod"
    ;;
  stub-hono)
    stub_pkg "hono"
    stub_glob "@hono/*"
    ;;
  stub-otel)
    stub_glob "@opentelemetry/*"
    stub_glob "@vercel/otel"
    ;;
  stub-sentry)
    stub_glob "@sentry/*"
    stub_glob "@sentry-internal/*"
    ;;
  stub-plain)
    stub_glob "@team-plain/*"
    ;;
  stub-ably)
    stub_pkg "ably"
    ;;
  stub-ccstate)
    stub_pkg "ccstate"
    ;;
  stub-misc)
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
  no-vitest-globals)
    patch_tsconfig 'c.types = ["node"]'
    ;;
  no-dom-lib)
    patch_tsconfig 'c.lib = ["ES2022"]'
    ;;
  no-vitest-and-dom)
    patch_tsconfig 'c.types = ["node"]; c.lib = ["ES2022"]'
    ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 1
    ;;
esac

echo "--- ablation [$variant] applied"
