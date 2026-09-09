# Clerk customization

This guide defines the styling boundary for the hosted Clerk authentication UI
under `turbo/apps/platform/src/views/auth-v1`. The goal is not to reproduce
Auth V2 inside Clerk. The goal is a branded, legible, accessible auth surface
that continues to use Clerk's public customization contract.

## Ownership

The maintenance rule is simple: the code that owns the DOM also owns its
control styling and states.

| Surface             | Owner       | Application responsibility                                                                                    |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| Auth V1 page canvas | Application | Background, safe areas, centering, theme toggle, and brand navigation through `AuthShell`                     |
| Auth V1 hosted card | Clerk       | Internal DOM, controls, spacing, validation, focus behavior, and authentication states                        |
| Auth V1 adaptation  | Application | Semantic variables, official Clerk options, card frame, wordmark, and narrowly justified public element slots |
| Auth V2             | Application | Its own DOM, styles, state presentation, accessibility, and tests                                             |

Auth V1 and Auth V2 share `AuthShell` and semantic design values such as
`--card`, `--foreground`, `--primary`, and `--radius-lg`. They do not share
button, input, OTP, checkbox, passkey, or other DOM-level Tailwind recipes.
Their card dimensions currently use equivalent values from independent
definitions. Do not couple them only to deduplicate those values; share a new
token only after both versions intentionally adopt the same product contract.

## Sources of truth

| Concern                                                   | Source                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| Provider-level semantic variables and Clerk cascade layer | `turbo/apps/platform/src/views/auth-v1/provider-appearance.ts`         |
| Auth component options and public element slots           | `turbo/apps/platform/src/views/auth-v1/component-appearance.ts`        |
| Shared page canvas and brand shell                        | `turbo/apps/platform/src/views/auth/auth-shell.tsx`                    |
| Clerk layer order and V1 card geometry                    | `turbo/apps/platform/src/views/css/index.css`                          |
| Exact browser artifact versions                           | `turbo/apps/platform/src/lib/clerk-versions.ts` and its `package.json` |
| Real hosted UI coverage                                   | `e2e/playwright/tests/auth-v1.spec.ts`                                 |

The current contract has two appearance levels. Provider appearance maps
application semantics into Clerk and assigns Clerk's stylesheet to its own
cascade layer:

```ts
return {
  cssLayerName: "clerk",
  variables: {
    colorBackground: "hsl(var(--card))",
    colorForeground: "hsl(var(--foreground))",
    colorPrimary: "hsl(var(--brand-text))",
    colorBorder: "hsl(var(--border))",
    colorRing: "hsl(var(--ring))",
    colorDanger: "hsl(var(--destructive))",
  },
};
```

Provider appearance must not contain `elements`. Authentication-specific
element overrides belong on `SignIn` and `SignUp`, so unrelated Clerk surfaces
cannot inherit them.

Component appearance selects an official Clerk theme and options, then adapts
only public slots:

```ts
return {
  theme: "simple",
  options: {
    elevation: "raised",
    logoLinkUrl: authBrand.homeUrl,
    socialButtonsPlacement: "top",
    socialButtonsVariant: "blockButton",
  },
  elements: {
    rootBox: "...",
    cardBox: "...",
    card: "...",
    logoImage: "...",
  },
};
```

This abbreviated example describes the shape, not a permanent element-key
allowlist. A public slot such as `otpCodeFieldInput` may be added for an
observed legibility or interaction defect. That does not authorize styling all
Clerk controls for visual parity with Auth V2.

Clerk's styles sit between base styles and application components/utilities:

```css
@layer theme, base, clerk, components, utilities;
```

This layer order lets Tailwind classes supplied through public Clerk slots win
through the normal cascade. It removes any need for specificity escalation.

## Allowed customization

Use the smallest public contract that resolves the observed problem:

1. Fix page background, scrolling, safe-area, or brand navigation in
   `AuthShell` or the V1 page wrapper, because the application owns that DOM.
2. Change a provider variable when a semantic color, font, or radius mapping is
   wrong for every hosted auth state.
3. Prefer an official Clerk `theme` or `options` setting when it expresses the
   requirement.
4. Add one component-level `appearance.elements` slot when the real Clerk UI
   has a concrete contrast, focus, overflow, visibility, or accessibility
   defect. Use Tailwind classes and existing semantic tokens.
5. Keep the override on the public slot itself. Do not reach into descendants
   that Clerk owns.

The stopping condition is that every required flow is usable, readable,
keyboard-focusable, and free of overflow, while the page shell, brand, and card
frame remain coherent with the application. Differences in Clerk's internal
spacing or control treatment are acceptable after that condition is met.

## Prohibited customization

Do not recreate the legacy Clerk DOM adapter. In Auth V1 production code:

- Do not inject `<style>`, import a route-owned stylesheet, use inline styles,
  or add CSS-in-JS element objects.
- Do not use `!important`.
- Do not target `.cl-*`, generated `cl-internal-*` classes, `[class*=...]`,
  `data-localization-key`, element structure, or `:has()`.
- Do not query or mutate Clerk's rendered DOM to apply styling.
- Do not import Auth V2 components or its control-level class recipes.
- Do not add overrides only to make Clerk's inputs, OTP, checkbox, passkey, or
  internal spacing look exactly like Auth V2.

If a product requirement needs broad control over Clerk's internal layout or
states and its public slots cannot express it, that requirement belongs in an
application-owned UI such as Auth V2. It is not a reason to expand Auth V1 into
an internal-DOM adapter.

## Lint

Run the focused check from `turbo/apps/platform`:

```bash
pnpm lint:clerk-customize
```

The check scans production TypeScript under `src/views/auth-v1` and rejects the
legacy patterns above. Its failure output directs contributors back to this
guide. It intentionally excludes tests: deployed E2E may locate `.cl-*`
elements to observe the real third-party UI, but production styling must not
depend on those selectors.

Passing lint proves only that the known unsafe mechanisms are absent. A new
public element override still needs a concrete defect, the narrowest affected
slot, semantic tokens, and relevant UI verification.

## Verification and upgrades

Platform Vitest replaces `@clerk/react` at the external package boundary. Those
tests verify application routing, props, loading, redirects, and lifecycle;
they are not visual evidence for hosted Clerk markup.

`e2e/playwright/tests/auth-v1.spec.ts` loads the real hosted Clerk UI against a
development instance and refuses production publishable keys. It currently
covers light and dark themes, desktop and mobile layouts, sign-in and sign-up,
password feedback and reveal, consent, OTP errors and retry, help and password
recovery, optional passkey availability, resource failure recovery, and test
user cleanup.

Clerk browser artifacts are exact-version contracts. The package versions and
the constants in `turbo/apps/platform/src/lib/clerk-versions.ts` must stay
aligned; runtime loading rejects a mismatched UI version. An upgrade must run
the existing real-UI E2E and perform a focused visual smoke check on the
affected themes, viewports, and auth states. Large screenshot snapshot suites
are not required by default.

## Why the old approach is forbidden

Before Auth V2, hosted Clerk styling combined provider appearance, component
appearance, and a route-level raw stylesheet of roughly 379 lines. That sheet
depended on Clerk classes, partial class matches, internal attributes, DOM
structure, and extensive `!important` declarations.

That model split ownership: Clerk could change the DOM while the application
remained responsible for every visual break. Fixes accumulated specificity,
dark-mode, password-toggle, checkbox, OTP, and passkey exceptions. Upgrading
Clerk effectively meant upgrading an undocumented DOM API with no type safety.

Auth V1 instead gives Clerk semantic constraints through its public API. Auth
V2 takes the other coherent option and owns both DOM and styling. Do not combine
those models by asking Clerk to render a page that application CSS then forces
to behave like Auth V2.
