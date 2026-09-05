# Residual Platform Brand Names

Classification of every `zero-*` name that remained in `turbo/apps/platform` and
`turbo/packages/ui` after #31802 renamed the design-token prefix and #31815
renamed the `data-vm0-*` DOM attributes. #31816 produced it.

A hyphenated `zero-` name is not one kind of thing. Some are internal CSS
identifiers nobody outside the repository can observe; some are the names of
databases and keys held on a user's own device, where a rename silently destroys
state; some are published asset paths; some are the English word "zero". This
document records which is which, so the residual brand-name guard (#31813) can
consume the classification instead of rediscovering it, and so a future prefix
sweep does not treat the whole set as one rename list.

Categories below are the ones the guard's manifest defines in
`RESIDUAL_BRAND_BOUNDARY_CATEGORIES`. A boundary entry is a permanent rule with
a reason. A baseline entry is a name still awaiting a decision, and it carries
an owning issue.

This document quotes every name it classifies, so the guard needs an
`out-of-scope` file rule for it for the same reason its own manifest has one.

## Method

Measured on `main` at `82f7578`:

```bash
git grep -nE 'zero-[a-z0-9]' -- turbo/apps/platform turbo/packages/ui
git grep -ohE 'zero-[a-z0-9-]+' -- turbo/apps/platform turbo/packages/ui | sort -u
```

52 distinct names over 122 occurrences, of which 29 names and 85 occurrences sit
outside `CHANGELOG.md`. #31816's issue body quoted 51 names and 78 occurrences
from an earlier inventory pass with a slightly different token regex; the
classification below covers the full 52 either way.

The narrower acceptance grep #31802 established stays empty, because it only
matches names introduced by `.` or `--`:

```bash
git grep -nE '(--|\.)zero-[a-z0-9-]+' -- turbo/apps/platform turbo/packages/ui
```

## Renamed by #31816

Fifteen names. Each is defined inside this repository, persists nothing, and is
not part of any published artifact, so `zero-` became `okou-` with the rest of
the name unchanged — the same shape as #31802.

| Name                          | Kind               | Site                                                 |
| ----------------------------- | ------------------ | ---------------------------------------------------- |
| `zero-shimmer`                | CSS `@keyframes`   | `apps/platform/src/views/css/index.css`              |
| `zero-thinking-in`            | CSS `@keyframes`   | `apps/platform/src/views/css/index.css`              |
| `zero-locator-landed`         | CSS `@keyframes`   | `apps/platform/src/views/css/index.css`              |
| `zero-block-pop`              | CSS `@keyframes`   | `apps/platform/src/views/css/index.css`              |
| `zero-realtime-status-reveal` | CSS `@keyframes`   | `apps/platform/src/views/css/index.css`              |
| `zero-dialog-overlay-in`      | CSS `@keyframes`   | `packages/ui/src/styles/globals.css`                 |
| `zero-dialog-overlay-out`     | CSS `@keyframes`   | `packages/ui/src/styles/globals.css`                 |
| `zero-dialog-blur-in`         | CSS `@keyframes`   | `packages/ui/src/styles/globals.css`                 |
| `zero-dialog-content-in`      | CSS `@keyframes`   | `packages/ui/src/styles/globals.css`                 |
| `zero-dialog-content-out`     | CSS `@keyframes`   | `packages/ui/src/styles/globals.css`                 |
| `zero-icon`                   | CSS class          | `.owf-diagram-zero-icon` -> `.owf-diagram-okou-icon` |
| `zero-thinking-spinner-frame` | marker class       | `views/okou-page/chat-thread-page.tsx`               |
| `zero-nav-recent-label`       | marker class       | `views/okou-page/sidebar-threads.tsx`                |
| `zero-agent-name`             | DOM `id`           | `views/okou-page/settings-tab.tsx`                   |
| `zero-attachment-url`         | client logger name | `views/okou-page/attachment-url.ts`                  |

A `@keyframes` name and every `animation:` shorthand naming it must move
together; a half-renamed animation silently stops playing rather than failing a
build. #31816 renamed each pair in one edit and asserted afterwards that every
renamed name has both a definition and a reference.

One of the fifteen does leave the repository, and it is the only one that does.
`logger(name)` in `signals/log.ts` is registered as a Sentry `logger` tag by
`captureSentryLogError`, so renaming `zero-attachment-url` changes the tag value
on that module's future error events. Past events keep the old value and a saved
Sentry search or alert pinned to `logger:zero-attachment-url` stops matching.
That is an observability discontinuity, not a data or contract boundary: nothing
reads the tag back, and no in-repo alert definition names it. The rename stands;
the discontinuity is recorded here so it is not rediscovered as a mystery.

`zero-thinking-spinner-frame` and `zero-nav-recent-label` are marker classes:
they appear in a `className` and match no CSS rule and no test selector anywhere
in the repository. They document what an element is, so they were renamed rather
than deleted.

Two stale references were corrected rather than renamed, because the files they
named no longer exist: a `zero-chat.ts` provenance note in
`signals/okou-page/chat-draft.ts` and a `zero-chat-composer.tsx` pointer in
`views/okou-page/chat-feedback-selection.tsx`. Two dead lint overrides for
`src/signals/zero-page/**`, a directory deleted before this cleanup began, were
removed from `.oxlintrc.json` and `eslint.config.js`; both globs matched no
file.

## Boundaries

### `immutable-history` — release changelogs

Twenty-five names appear only in `turbo/apps/platform/CHANGELOG.md`:
`zero-account-page`, `zero-app`, `zero-app-shell`, `zero-chat`,
`zero-chat-composer`, `zero-chat-page`, `zero-job-detail`,
`zero-job-detail-page`, `zero-jobs-page`, `zero-meet`, `zero-model-preference`,
`zero-native`, `zero-onboarding`, `zero-prop`, `zero-run-service`,
`zero-schedule-card`, `zero-schedule-detail-page`, `zero-schedule-page`,
`zero-schedule-tab`, `zero-send-key`, `zero-session-chat-page`,
`zero-settings-tab`, `zero-sidebar`, `zero-slack-connect-page`,
`zero-works-page`.

Release-please owns that file and each entry describes what shipped under the
name in force at the time. They are covered by the guard's existing
`immutable-history/package-changelog` file rule; no per-name entry is needed.

### `immutable-static-asset-key` — published asset paths

| Name                            | Site                                               | Reason                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zero-page`                     | `views/zero-page/**` keys, 39 occurrences          | The key is the path of an object already published under `static.vm0.io`; the repository holds the reference, not the object. Renaming it 404s the asset. |
| `zero-avatar-face-19a2ae88c11d` | `views/onboarding/onboarding-workflow-diagram.tsx` | Content-hashed published SVG filename. The hash is part of the identity, so the name cannot be edited without republishing under a new hash.              |
| `zero-avatar-hair-c1d917488df8` | `views/onboarding/onboarding-workflow-diagram.tsx` | Same.                                                                                                                                                     |
| `zero-avatar-head-840043d16b50` | `views/onboarding/onboarding-workflow-diagram.tsx` | Same.                                                                                                                                                     |

### `wire-and-persisted-value` — client-persisted identities

Both are decided in full below.

| Name                            | Site                                          | Decision |
| ------------------------------- | --------------------------------------------- | -------- |
| `zero-intro-video-drafts`       | `signals/external/intro-video-draft-store.ts` | Kept     |
| `zero-install-banner-dismissed` | `signals/pwa-install.ts`                      | Kept     |

### `external-identity`

| Name                | Site                                 | Reason                                                                                                                      |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `zero-fractions`    | `apps/platform/.oxlintrc.json`       | `no-zero-fractions` is an oxlint rule id. The linter defines the name; renaming it disables the rule silently.              |
| `zero-design-color` | `packages/ui/src/styles/globals.css` | `https://zero-design-color.sites.vm0.io` is a deployed site. A source edit does not move the host, it only breaks the link. |

### `semantic-non-brand`

| Name         | Site                                                      | Reason                                                                                                                     |
| ------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `zero-sized` | `views/okou-page/image-annotation-editor.tsx:58`          | English prose: "would leave a zero-sized mark".                                                                            |
| `zero-usage` | `views/okou-page/__tests__/chat-run-history.test.tsx:890` | Fixture id for a usage event carrying `creditUsage(0, [])` — a run that consumed zero credits. The numeral, not the brand. |

## Baseline — still undecided

| Name        | Site                       | Owner  | Reason                                                                                                                                                                                  |
| ----------- | -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zero-left` | `views/css/index.css:1542` | #31840 | `--workflow-zero-left`. #31816's brief labelled this semantic and excluded it from scope; it is not. It positions the Zero avatar node in the onboarding diagram, and nothing reads it. |
| `zero-size` | `views/css/index.css:1543` | #31840 | `--workflow-zero-size`. Same declaration block, and `72px` is exactly the `.owf-diagram-avatar` box. Also unreferenced.                                                                 |

Both are dead declarations, so #31840 can delete rather than rename them. They
were left untouched here because #31816's scope explicitly excluded them, and
changing a name the brief said not to change is worse than recording that the
brief was wrong.

## Persisted-Key Decisions

Renaming a name the browser stores is not a rename. The old name keeps the data
and the new name starts empty, so the user loses state without any error. Both
of the platform's persisted `zero-*` names are therefore kept, with the decision
recorded at the declaration site.

### `zero-intro-video-drafts` — kept

`signals/external/intro-video-draft-store.ts` passes it to `openDB()`, so it is
an IndexedDB database name holding the user's saved intro-video draft, blob
included.

- **If renamed with no migration:** every draft saved before the deploy is
  invisible. The old database still holds the blob and still consumes quota, and
  the wizard shows an empty state, so the user reads it as data loss.
- **Cost of migrating:** open both databases, copy the record, delete the old
  one, and do this on every client that ever loads the page again — including
  clients that reach it mid-write.
- **Users who never return:** they keep an orphaned IndexedDB database on their
  device forever, because only their own browser can delete it. No migration can
  reach them.
- **Removal gate:** rename only inside a slice that already has to restructure
  this store and can carry the copy as part of its own work.

### `zero-install-banner-dismissed` — kept

`signals/pwa-install.ts` reads it through `localStorageSignals`, so it is a
localStorage flag recording that the user dismissed the PWA install banner.

- **If renamed with no migration:** the banner reappears once for every user who
  had already dismissed it.
- **Why not a dual read:** reading the legacy key alongside a new one would
  prevent that, but the flag has no expiry and no writer that would retire it,
  so the tolerant branch would have no verifiable removal gate.
  `docs/fallback.md` §8 rejects exactly that — a tolerated old shape with no
  removal condition is not a rollout fallback.
- **Users who never return:** unaffected either way; the flag is only read on a
  page load they never make.
- **Removal gate:** rename when the install banner is next reworked and the flag
  is being rewritten anyway.

Neither decision introduces a fallback branch, so neither carries a
`docs/fallback.md` §9 declaration.
