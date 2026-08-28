# @okouai/mermaid-flowchart

Private workspace package containing vm0's flowchart-only build of Mermaid.
It supports `flowchart` plus the legacy `graph` spelling and uses Dagre for
layout. Other Mermaid diagram syntaxes are intentionally unsupported.

The generated ESM files are committed so normal vm0 installs and builds do not
clone or compile Mermaid. The entry module stays statically imported by the
platform; the upstream Flowchart parser and Dagre renderer remain split into
their own internal chunks.

## Bundle footprint

For the pinned 11.16.1 source, a focused esbuild 0.28.1 production bundle
(`--bundle --splitting --format=esm --minify --target=es2022`) produced:

- stock Mermaid: 105 JavaScript files, 3,425,190 raw bytes, 979,863 gzip bytes;
- this Flowchart-only build: 5 JavaScript files, 757,025 raw bytes, 196,453
  gzip bytes; and
- a reduction of 77.9% raw and 79.9% gzip across the complete static and lazy
  Mermaid output graph.

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

Copy `packages/mermaid/dist/mermaid.esm.tiny.min.mjs` and its
`chunks/mermaid.esm.tiny.min` directory into this package's `dist` directory,
then run:

```sh
pnpm --filter @okouai/mermaid-flowchart test
```

The test pins every generated file's SHA-256 digest and verifies that both
Flowchart spellings parse while representative non-Flowchart syntaxes do not.
