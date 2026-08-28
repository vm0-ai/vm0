# @okouai/mermaid-lite

Private workspace package containing vm0's focused Mermaid build. It supports
`flowchart`, the legacy `graph` spelling, and `sequenceDiagram`; other Mermaid
diagram syntaxes are intentionally unsupported.

The generated ESM file is committed so normal vm0 installs and builds do not
clone or compile Mermaid. The Flowchart and Sequence Diagram parsers and the
Dagre renderer are statically linked into that file, so importing this package
cannot create another browser JavaScript chunk.

## Bundle footprint

For the pinned 11.16.1 source, focused esbuild 0.28.1 production bundles
(`--bundle --format=esm --minify --target=es2022`) produced:

- stock Mermaid: 105 JavaScript files, 3,425,190 raw bytes, 979,863 gzip bytes;
- the previous statically linked Flowchart-only build: 1 JavaScript file,
  759,957 raw bytes, 199,124 gzip-9 bytes, and 165,257 Brotli-11 bytes;
- this Flowchart plus Sequence Diagram build: 1 JavaScript file, 879,075 raw
  bytes, 230,384 gzip-9 bytes, and 187,297 Brotli-11 bytes; and
- restoring Sequence Diagram costs 119,118 raw bytes, 31,260 gzip-9 bytes, and
  22,040 Brotli-11 bytes in the standalone generated package.

Gzip totals compress each emitted file independently, matching browser asset
delivery rather than treating all chunks as one archive.

## Upstream source

- Repository: <https://github.com/mermaid-js/mermaid>
- Tag: `@mermaid-js/tiny@11.16.1`
- Commit: `7ecca0cd7f1658ef74f4e7e91f925724ef403bbf`
- Patch: [`upstream/flowchart-sequence.patch`](./upstream/flowchart-sequence.patch)
- License and modifications: [`NOTICE.md`](./NOTICE.md)

## Rebuild

Use a disposable checkout of the pinned upstream commit:

```sh
git clone https://github.com/mermaid-js/mermaid.git mermaid-lite-build
cd mermaid-lite-build
git checkout 7ecca0cd7f1658ef74f4e7e91f925724ef403bbf
git apply /absolute/path/to/turbo/packages/mermaid-lite/upstream/flowchart-sequence.patch
corepack pnpm install --frozen-lockfile
corepack pnpm build:esbuild
```

Bundle the patched tiny entry once more without splitting, writing it into this
package, then run its verification:

```sh
corepack pnpm exec esbuild packages/mermaid/dist/mermaid.esm.tiny.min.mjs \
  --bundle --format=esm --minify --target=es2022 \
  --outfile=/absolute/path/to/vm0/turbo/packages/mermaid-lite/dist/mermaid.esm.min.mjs
pnpm --filter @okouai/mermaid-lite test
```

The test pins the generated file's SHA-256 digest, rejects internal JavaScript
imports, and verifies that both Flowchart spellings and Sequence Diagram parse
while representative unsupported syntaxes do not.
