# App style guide

The App design system has one component-facing styling API: Tailwind utilities. Business components in `turbo/apps/platform` and shared components in `turbo/packages/ui` must compose utilities directly, normally through `className`, `cn()`, or `cva()`.

First-party CSS class selectors are not a second component API. New CSS modules, `<style>` elements, runtime stylesheet injection, and CSS-in-JS are subject to the same boundary because they otherwise bypass Tailwind and the token system.

## Final state

The final goal is zero first-party CSS class selectors for business styling, including all existing selectors. Preventing growth is an interim guardrail, not completion of this goal.

- Business and shared UI components use Tailwind utilities and semantic component variants. They neither define nor depend on first-party styling classes, including classes that wrap `@apply`.
- Existing first-party selectors, their class dependencies, and component-owned inline or injected styles are eliminated. The legacy baseline is empty; existing code is not a permanent exception.
- Runtime behavior and tests use semantic roles, accessible names, refs, `data-*` hooks, or documented component slots instead of querying styling classes.
- Remaining handwritten CSS is limited to centrally managed design variables and tokens, explicitly allowlisted global environment rules, and explicitly allowlisted third-party DOM adapters. These exceptions do not authorize business styling.
- Every environment or adapter exception has an exact scope, owner, rationale, and removal condition. Third-party entries also identify the upstream DOM owner; vendored stylesheets are pinned to their exact content hash. Directory-wide ignores and class-prefix exemptions are not allowed.
- The design system has a documented ownership chain from primitive variables to semantic tokens, Tailwind utilities, and component variants, including naming, theme mapping, introduction, change, deprecation, and review. Components reuse that contract instead of creating a parallel variable or token registry.
- Lint and agent instructions enforce the same boundary. Failures direct contributors to this guide and the underlying fix; business selectors cannot be authorized by disabling lint, expanding a baseline, or adding an allowlist entry.
- The final automated audit reports zero first-party selector declarations, zero business-component dependencies on legacy styling APIs, and only validated global-environment and third-party-DOM exceptions.

The current lint freezes legacy state while it still exists. Passing that check establishes compliance with the current guardrail; it does not establish that existing first-party selectors have been cleared. The complete goal is tracked in [#32402](https://github.com/vm0-ai/vm0/issues/32402).

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

## Token and variant governance

New tokens must represent a reusable semantic decision, have a documented consumer contract, and define their light and dark theme behavior in the canonical stylesheet. Shared tokens and variants belong to `@okouai/ui`; App-only tokens belong to the App token layer. A new alias for one component's hard-coded values is not a token contract.

Token and variant changes are reviewed at their owning layer together with affected consumers and theme behavior. A rename or semantic change must update those consumers; deprecated names are removed when their consumers have migrated, rather than being copied into component-local registries. A change to ownership, naming, or theme mapping must update this guide in the same PR.

Large editable surfaces use `border-surface-focus` to emphasize their existing border on focus: neutral gray in light themes and muted amber in dark themes. Keep the border width constant across interaction states. A shadow-only focus overlay may fade through opacity, but must not duplicate the surface border or depend on a negative inset to align its edge. The chat composer uses the default `border` width for its surface and connector circles; intentional badge overlap remains independent of border geometry. `data-slot="chat-composer-card"` identifies the editable card for keyboard positioning and page tests.

## Exception boundary

Only two exception kinds exist:

- `global-environment` covers document-level browser or theme state that cannot be represented by a component utility.
- `third-party-dom-adapter` covers DOM or isolated documents whose element classes are owned outside the business component.

Every exception identifies the exact file and selector or injected-style fingerprint, its owner, rationale, and removal condition. Third-party adapters also identify their upstream DOM owner. A styling convenience, missing utility, or existing first-party convention is not an exception. Vendored CSS is pinned by exact path and SHA-256 rather than by a directory-wide ignore.

## Shrink-only legacy state

`turbo/style-legacy-baseline.json` records current first-party selector declarations as normalized CSS AST atoms, including nested selector ancestry, conditional at-rules, `@scope` roots and limits, and `@apply` contents. A class-qualified scope also freezes its `:scope`, `&`, and element-selector declarations; scope boundaries participate in exact baseline and adapter matching. Legacy class dependencies are counted at their consuming attributes or calls, resolving local constants, imported aliases, and re-exports. Reusing an existing constant in another consumer is a new dependency. The baseline also fingerprints existing inline or injected styles that are not permanent adapters.

The baseline is not an allowlist and has no command that expands it. A new selector, a changed declaration, a new use of an existing legacy class, or a new style injection fails lint. Removing legacy state intentionally makes the baseline stale; `pnpm lint:style:prune` only intersects the baseline with current source and refuses to authorize growth. Pre-commit compares the baseline with `HEAD`, while CI compares it with the pull request or merge-queue base SHA, so manually editing source and baseline together cannot bypass the ratchet.

Commands run from `turbo`. An invalid Git reference, unreadable baseline, or malformed JSON fails with a nonzero exit status and a pointer to this guide. Only a reference commit genuinely predating the baseline file permits its initial introduction. That bootstrap case applies to local/CI repository history, not production version compatibility; once the target base contains the baseline, the ratchet is mandatory.

## Enforcement and feedback

Run the complete check from `turbo`:

```bash
pnpm lint:style
```

The check has three layers:

1. The repository policy compares CSS AST atoms, legacy class dependency counts, injected-style fingerprints, exact adapter entries, and vendored file hashes.
2. `@eslint/css` parses first-party CSS with Tailwind v4 syntax and disallows inline ESLint configuration for this check.
3. `eslint-plugin-better-tailwindcss/no-unknown-classes` validates component class strings against the real App Tailwind entry point while accepting only the recorded legacy tokens.

CI runs this as the independent required `lint-style` job. The pre-commit hook runs the fast repository policy so the most actionable boundary failures are returned before push. Both policy diagnostics and the full lint command's failure output direct contributors to `docs/styles.md` for the style guide. The full command keeps a failing exit status for policy, CSS, Tailwind, or test failures.

When a style check fails, read this guide and replace business styling with the appropriate Tailwind utilities and registered tokens. Prune the baseline when legacy code has been removed. Do not suppress the check or add a business styling exception to make it pass.
