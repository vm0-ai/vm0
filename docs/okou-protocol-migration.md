# Okou protocol migration

This document records the Phase B protocol contract for issues #26487 and
#26490, the new-context writer stop tracked by #26652, and the current-artifact
CLI canonicalization tracked by #26711. Phase B is live at release target
`d2fddbf6714b35182e1ef4b787adf84724f6ee02`.

## Canonical and compatibility surfaces

Current first-party Platform, private CLI, Zero Desktop, and Okou Desktop
clients send branded requests through `/api/okou/**`. Active typed contracts
also use that namespace. The API registration and runtime-schema layers still
publish the same handlers and schemas through `/api/zero/**` for older clients,
pinned CLI artifacts, installed Desktop builds, and stored callback URLs.

OAuth start requests use the canonical Okou namespace. Canonical Slack and
Teams starts also send canonical callback URLs after their centrally managed
provider allowlists were expanded; requests through the Zero compatibility
alias keep sending the legacy callback URL. Current Feishu Platform flows use
the neutral app callback, and current GitHub connector flows use the neutral
connector callback. Their legacy branded callbacks remain available for old
flows. Both branded callback paths reach the same provider handler.

Current API and Desktop consumers prefer `OKOU_*` variables and retain their
`ZERO_*` fallback readers. The current private CLI source reads only canonical
Okou runtime context and accepts only Okou-scope run tokens. Historical
commit-addressed CLI artifacts retain their compatibility readers for the
execution contexts that selected them. New first-party Okou-agent and
presentation-template execution contexts emit only:

- `OKOU_APP_URL`;
- `OKOU_AGENT_ID`;
- optional `OKOU_CHAT_THREAD_ID`; and
- one `OKOU_TOKEN` with `scope: "okou"`.

The token retains the existing sandbox prefix, identity, organization, run,
capability, optional Computer Use host, optional browser, issued-at, and expiry
claims. New contexts no longer generate, store, or inject `ZERO_TOKEN`, the
other branded `ZERO_*` aliases, or the retired
`ZERO_CONNECTOR_ACTION_CALLBACK_ENABLED` marker. Token values remain inside the
existing secret boundary and must not be logged, rendered into prompts,
telemetry, snapshots, or PR text.

## Compose and queued-context compatibility

New API-authored agent compose versions use canonical `OKOU_AGENT_ID` and
`OKOU_TOKEN` templates. Existing content-addressed compose versions are not
rewritten or rehashed. When a new first-party branded context uses a persisted
version containing legacy `ZERO_*` templates, the run builder omits those
templates from that new context's runtime projection so unresolved template
text and legacy environment keys cannot reach the sandbox.

Already-stored queued, active, and finalizing execution contexts remain
byte-for-byte unchanged. Their stored `ZERO_*` environment, Zero-scoped token,
and historical `CLI_PKG_URL` continue through the historical CLI artifact and
normal runner and API compatibility readers. Both HTTP namespaces remain
routed, and the API continues to accept both token scopes.

The current CLI defaults to `https://api.okou.ai` and sends branded requests
through `/api/okou/**`. Merging that host change requires the custom domain to
have valid TLS and to reach the production API boundary; static App HTML,
redirects, and an unreachable hostname do not pass the gate. The existing
`VM0_API_BACKEND_URL` override remains available for development, previews,
and operational rollback.

Removing any other fallback reader, `/api/zero/**` route, server-side Zero
token-scope verifier, historical artifact, callback, Desktop identity, or
persisted object requires a separate drain gate. The focused current-CLI slice
is safe only because old contexts keep their stored commit-addressed artifact
while the released writer stop makes new contexts canonical-only. Production
verification must inspect names and token scope without exposing values;
declining Zero request volume alone is not proof that all legacy contexts have
drained.

## Provider callback inventory

Issue #26720 classifies supported provider callbacks by ownership and storage
boundary. Production is the only centrally allowlisted environment. Preview
URLs are job-scoped and are not automatically added to production provider
applications; development and focused integration tests use provider-boundary
mocks. “Present” below records configuration or durable-state presence only,
not callback values, request data, or user content.

| Provider surface                                                         | Classification and route class                                                                                       | Owner                                                            | Presence and migration action                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack OAuth install and user connect                                     | Generated callback plus provider-console redirect allowlist; branded callback                                        | VM0 provider operations                                          | Cutover gate: verify the production allowlist contains canonical and legacy entries before merge. Canonical starts emit `/api/okou/slack/oauth/callback`; compatibility starts keep `/api/zero/slack/oauth/callback`.   |
| Slack events, interactivity, and commands                                | Provider-console stored registrations; branded callbacks                                                             | VM0 provider operations                                          | Existing registrations are present and are not mutated. Both namespace acceptors remain because stored Zero registrations are still active.                                                                             |
| Microsoft Teams user OAuth                                               | Generated callback plus Microsoft Entra web redirect allowlist; branded callback                                     | VM0 provider operations                                          | Cutover gate: verify the production allowlist contains canonical and legacy entries before merge. Canonical starts emit `/api/okou/teams/oauth/callback`; compatibility starts keep `/api/zero/teams/oauth/callback`.   |
| Microsoft Teams bot messaging                                            | Provider-console stored registration; branded callback                                                               | VM0 provider operations                                          | Existing registration is retained without mutation; both `/api/okou/teams/bot` and its Zero alias remain accepted.                                                                                                      |
| Feishu user OAuth                                                        | Generated redirect plus per-installation provider-console allowlist                                                  | Installing organization administrator                            | Current Platform registration uses the neutral `/connectors/feishu/callback`. The legacy branded API redirect remains on the Zero alias for old clients and user-owned allowlists; no stored registration is rewritten. |
| Feishu events                                                            | Generated operator-setup URL plus per-installation stored registration; branded callback                             | Installing organization administrator                            | New setup output is already canonical at `/api/okou/feishu/events/:installationId`. Existing provider registrations are retained and both namespace acceptors remain.                                                   |
| GitHub App user authorization                                            | Generated callback plus provider-console allowlist and ephemeral stored OAuth state                                  | VM0 provider operations                                          | Current flows use the neutral `/api/connectors/github/callback`; the stored redirect is consumed unchanged. The legacy branded callback remains on its Zero alias for old in-flight flows.                              |
| GitHub App setup and webhooks                                            | Provider-console setup URL and stored webhook registration; neutral callbacks                                        | VM0 provider operations                                          | Present on `/api/github/app/setup/callback` and `/api/webhooks/github`; no branded producer exists to migrate.                                                                                                          |
| Telegram bots                                                            | Code-managed `setWebhook` registration plus durable installation record; neutral callback                            | Installing organization administrator                            | Present on `/api/telegram/webhook/:telegramBotId`; registrations and rollback behavior are unchanged.                                                                                                                   |
| Strapi                                                                   | Generated operator-setup URL plus provider-side stored registration; branded callback                                | Installing organization administrator                            | New setup output is already canonical at `/api/okou/strapi/events/:integrationId`; existing registrations and the Zero acceptor are retained.                                                                           |
| Google Workspace, Notion, Stripe, Clerk, email, and generation providers | Provider-console registration, provider subscription, or per-job generated URL; neutral `/api/webhooks/**` callbacks | VM0 provider operations or the owning workflow                   | Present and unbranded; no protocol producer migration is required.                                                                                                                                                      |
| Built-in and custom connector OAuth                                      | Generated callback plus durable OAuth state; neutral API or app callback                                             | Connector catalog owner or installing organization administrator | Redirect state is persisted and consumed verbatim. Existing states are not rewritten; no Zero callback producer is used by current flows.                                                                               |
| Workflow and run callbacks                                               | Durable callback records; neutral, internal, or user-configured destination                                          | Workflow or run owner                                            | Durable records are present and deliberately excluded from this producer migration. Historical URLs and delivery records remain unchanged.                                                                              |

Low-frequency safety does not rely on a short absence of requests. The rollout
keeps provider allowlist entries, stored registrations, durable callback
records, neutral routes, and both branded acceptors in place. A rollback can
therefore restore the previous producer while those records remain valid and
without a database or provider-registration rewrite.

## Rollback

Roll the writer stop back to the Phase B release target above to restore dual
emission. Roll the current CLI source back by selecting the last verified
dual-reader commit-addressed artifact and restoring the previous API origin.
Leave both namespace routes, server-side environment readers and token-scope
verifiers, both Desktop identities, stored callbacks, queued contexts, and
immutable historical artifacts in place. Release and production verification
remain separate from implementation changes.
