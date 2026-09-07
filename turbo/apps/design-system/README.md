# @okouai/design-system

The one place the product's design tokens and components are documented.

It is not a copy of the design system — it renders the real thing. The app
imports `apps/platform/src/views/css/index.css`, which already pulls in Tailwind
and `@okouai/ui/styles/globals.css` in order, so every swatch is painted by the
same custom property the product reads, and every component block imports the
real component.

```
pnpm -F @okouai/design-system dev     # http://localhost:3007
pnpm -F @okouai/design-system build
pnpm -F @okouai/design-system test    # coverage gate
```

## How it stays in sync

Nothing here is maintained by remembering to update it.

**Tokens.** `scripts/extract-tokens.mjs` parses both stylesheets and writes
`src/generated/tokens.json`, carrying each token's light value, dark value,
resolved hex and the source comment that documents it. A token added to either
file appears in the catalogue on the next `pnpm generate`.

**Component variants.** `scripts/extract-components.mjs` reads each component's
own `cva` variant map. The catalogue renders those exhaustively, so a variant
added to `button.tsx` renders itself.

**Component demos.** A generator cannot invent a meaningful demo, so those are
written by hand in `src/demos.tsx`. `src/__tests__/coverage.test.ts` compares
the demo list against the component files and fails when they diverge — adding
a component to `@okouai/ui` fails this app's test until the catalogue covers it.

Both generators run as part of `dev`, `build`, `test` and `check-types`, so the
generated manifests are never stale against the source in the same tree.

## Adding a component to the catalogue

1. Add the component to `packages/ui/src/components/ui`.
2. Add an entry to `DEMOS` in `src/demos.tsx` with the same `id` as the file
   name.
3. If it uses `cva` and the variants need a live preview rather than a value
   list, add a renderer to `VARIANT_RENDERERS` in `src/pages/components.tsx`.

## Layout

| Path                             | What it holds                                           |
| -------------------------------- | ------------------------------------------------------- |
| `scripts/extract-tokens.mjs`     | Stylesheet → token manifest                             |
| `scripts/extract-components.mjs` | Component source → export and variant manifest          |
| `src/manifest.ts`                | Typed access to both manifests                          |
| `src/demos.tsx`                  | Hand-written component demos                            |
| `src/coverage.ts`                | The sync gate                                           |
| `src/pages/`                     | Colour, typography, shape, workspace themes, components |
