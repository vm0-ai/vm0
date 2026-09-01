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

OAuth start requests use the canonical Okou namespace, while provider-facing
Slack, Teams, Feishu, and GitHub `redirect_uri` values deliberately remain on
the Zero alias until the corresponding third-party allowlists are migrated in
a separately verified rollout. Both callback paths reach the same handler.

Current API and Desktop consumers prefer `OKOU_*` variables and retain their
`ZERO_*` fallback readers. The current private CLI source reads only canonical
Okou runtime context and accepts only Okou-scope run tokens. Historical
commit-addressed CLI artifacts retain their compatibility readers for the
execution contexts that selected them. New first-party Okou-agent execution
contexts emit only:

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
byte-for-byte unchanged. Their stored `ZERO_*` environment and historical
`CLI_PKG_URL` continue through the historical CLI artifact and normal runner
and API compatibility readers. Both HTTP namespaces remain routed.

## Retired `zero` token scope

The API accepts run tokens with `scope: "okou"` only. The writer stop above
made `scope: "okou"` the sole issued value on 2026-08-12, run tokens live two
hours, and no table stores one, so the issuing side had drained by construction
and the retirement needed no separate window. A token presenting the legacy
`zero` scope now fails verification.

The current CLI defaults to `https://api.okou.ai` and sends branded requests
through `/api/okou/**`. It reads only `OKOU_API_BACKEND_URL` for an explicit API
override; when that variable is unset or empty, the production default remains
in effect. Merging a host change requires the custom domain to have valid TLS
and to reach the production API boundary; static App HTML, redirects, and an
unreachable hostname do not pass the gate. Historical commit-addressed CLI
artifacts remain immutable and retain the contracts they shipped with.

Removing any other fallback reader, `/api/zero/**` route, historical artifact,
callback, Desktop identity, or persisted object requires a separate drain gate.
The focused current-CLI slice is safe only because old contexts keep their
stored commit-addressed artifact
while the released writer stop makes new contexts canonical-only. Production
verification must inspect names and token scope without exposing values;
declining Zero request volume alone is not proof that all legacy contexts have
drained.

## Rollback

Roll the writer stop back to the Phase B release target above to restore dual
emission. Operational rollback for the current Product CLI keeps the
canonical-only API URL input: select a verified artifact and configure any
previous API origin through `OKOU_API_BACKEND_URL`. Do not restore
`VM0_API_BACKEND_URL`; its support cutoff is a product contract, not a rollout
fallback.
Leave both namespace routes, server-side environment readers, both Desktop
identities, stored callbacks, queued contexts, and immutable historical
artifacts in place. Restoring the `zero` token scope is not part of that
rollback; nothing has issued one since the writer stop. Release and production verification
remain separate from implementation changes.
