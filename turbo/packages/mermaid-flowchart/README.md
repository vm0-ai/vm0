# @okouai/mermaid-flowchart

Private workspace package containing vm0's flowchart-only build of Mermaid.
It supports `flowchart` plus the legacy `graph` spelling and uses Dagre for
layout. Other Mermaid diagram syntaxes are intentionally unsupported.

The generated ESM file is committed so normal vm0 installs and builds do not
clone or compile Mermaid. The Flowchart parser and Dagre renderer are statically
linked into that file, so importing this package cannot create another browser
JavaScript chunk.

## Bundle footprint

For the pinned 11.16.1 source, focused esbuild 0.28.1 production bundles
(`--bundle --format=esm --minify --target=es2022`) produced:

- stock Mermaid: 105 JavaScript files, 3,425,190 raw bytes, 979,863 gzip bytes;
- this statically linked Flowchart-only build: 1 JavaScript file, 759,957 raw
  bytes, 199,920 gzip bytes; and
- a reduction of 77.8% raw and 79.6% gzip across the complete Mermaid output.

Gzip totals compress each emitted file independently, matching browser asset
delivery rather than treating all chunks as one archive.

## Upstream source

- Repository: <https://github.com/mermaid-js/mermaid>
- Tag: `@mermaid-js/tiny@11.16.1`
- Commit: `7ecca0cd7f1658ef74f4e7e91f925724ef403bbf`
- Patch: [`upstream/flowchart-only.patch`](./upstream/flowchart-only.patch)
- License and modifications: [`NOTICE.md`](./NOTICE.md)

## Rebuild

Use a disposable checkout of the pinned upstream commit:

```sh
git clone https://github.com/mermaid-js/mermaid.git mermaid-flowchart-build
cd mermaid-flowchart-build
git checkout 7ecca0cd7f1658ef74f4e7e91f925724ef403bbf
git apply /absolute/path/to/turbo/packages/mermaid-flowchart/upstream/flowchart-only.patch
corepack pnpm install --frozen-lockfile
corepack pnpm build:esbuild
```

Bundle the patched tiny entry once more without splitting, writing it into this
package, then run its verification:

```sh
corepack pnpm exec esbuild packages/mermaid/dist/mermaid.esm.tiny.min.mjs \
  --bundle --format=esm --minify --target=es2022 \
  --outfile=/absolute/path/to/vm0/turbo/packages/mermaid-flowchart/dist/mermaid.esm.min.mjs
pnpm --filter @okouai/mermaid-flowchart test
```

The test pins the generated file's SHA-256 digest, rejects internal JavaScript
imports, and verifies that both Flowchart spellings parse while representative
non-Flowchart syntaxes do not.
