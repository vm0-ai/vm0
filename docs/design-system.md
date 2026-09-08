# Design system and style policy

The App design system has one component-facing styling API: Tailwind utilities. Business components in `turbo/apps/platform` and shared components in `turbo/packages/ui` must compose utilities directly, normally through `className`, `cn()`, or `cva()`.

First-party CSS class selectors are not a second component API. New CSS modules, `<style>` elements, runtime stylesheet injection, and CSS-in-JS are subject to the same boundary because they otherwise bypass Tailwind and the token system.

## Sources of truth

| Concern                                         | Source of truth                                                                    | Consumer contract                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Primitive and runtime theme values              | `turbo/packages/ui/src/styles/globals.css` under `:root` and `[data-theme="dark"]` | Referenced through semantic variables, not directly from components          |
| Tailwind design tokens                          | Shared `@theme` definitions in `turbo/packages/ui/src/styles/globals.css`          | Utilities such as `bg-background`, `text-muted-foreground`, and `rounded-lg` |
| App-only semantic tokens                        | `@theme` in `turbo/apps/platform/src/views/css/index.css`                          | Named utilities for an App domain concept; promote to UI when shared         |
| Component variants                              | TypeScript component APIs and `cva()` definitions                                  | A bounded set of semantic props and Tailwind utility combinations            |
| Global environment and generated DOM adaptation | `turbo/style-allowlist.json`                                                       | Infrastructure-only exception with exact selector or injection fingerprint   |

Token names describe meaning rather than a page or component. A reusable interaction state, surface, foreground, border, radius, or typography decision belongs in the shared token layer. A product-specific data visualization category may remain App-only until another product consumes it. Theme differences are assigned at the primitive/runtime variable layer; components continue to use the same semantic utility in both themes.

Components must not introduce local CSS variables as an alternate token registry. A runtime value that is genuinely computed by the component may use a narrowly named custom property as data, while its visual semantics still come from Tailwind utilities and registered tokens.

## Exception boundary

Only two exception kinds exist:

- `global-environment` covers document-level browser or theme state that cannot be represented by a component utility.
- `third-party-dom-adapter` covers DOM or isolated documents whose element classes are owned outside the business component.

Every exception identifies the exact file and selector or injected-style fingerprint, its owner, rationale, upstream DOM owner, and removal condition. A styling convenience, missing utility, or existing first-party convention is not an exception. Vendored CSS is pinned by exact path and SHA-256 rather than by a directory-wide ignore.

## Shrink-only legacy state

`turbo/style-legacy-baseline.json` records current first-party selector declarations as normalized CSS AST atoms and current legacy class dependencies by file and count. It also fingerprints existing inline or injected styles that are not permanent adapters.

The baseline is not an allowlist and has no command that expands it. A new selector, a changed declaration, a new use of an existing legacy class, or a new style injection fails lint. Removing legacy state intentionally makes the baseline stale; `pnpm lint:style:prune` only intersects the baseline with current source and refuses to authorize growth. Pre-commit compares the baseline with `HEAD`, while CI compares it with the pull request or merge-queue base SHA, so manually editing source and baseline together cannot bypass the ratchet.

## Enforcement and feedback

Run the complete check from `turbo`:

```bash
pnpm lint:style
```

The check has three layers:

1. The repository policy compares CSS AST atoms, legacy class dependency counts, injected-style fingerprints, exact adapter entries, and vendored file hashes.
2. `@eslint/css` parses first-party CSS with Tailwind v4 syntax and disallows inline ESLint configuration for this check.
3. `eslint-plugin-better-tailwindcss/no-unknown-classes` validates component class strings against the real App Tailwind entry point while accepting only the recorded legacy tokens.

CI runs this as the independent required `lint-style` job. The pre-commit hook runs the fast repository policy so the most actionable boundary failures are returned before push. Error messages direct business code back to Tailwind utilities and never suggest adding an allowlist entry.
