# Okou protocol migration

This document records the Phase B protocol contract for issues #26487 and
#26490 and the new-context writer stop tracked by #26652. Phase B is live at
release target `d2fddbf6714b35182e1ef4b787adf84724f6ee02`.

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

Current consumers prefer `OKOU_*` variables and fall back to their `ZERO_*`
aliases. New first-party Okou-agent and presentation-template execution
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
byte-for-byte unchanged. Their stored `ZERO_*` environment, Zero-scoped token,
and historical `CLI_PKG_URL` continue through the normal runner and API
compatibility readers. The API and CLI still prefer `OKOU_*` with `ZERO_*`
fallback, both HTTP namespaces remain routed, and both token scopes remain
accepted.

Removing any fallback reader, `/api/zero/**` route, Zero token-scope verifier,
historical artifact, callback, Desktop identity, or persisted object requires a
separate drain gate. Production verification of the writer stop must inspect
new context names and token scope without exposing values; declining Zero
request volume alone is not proof that all legacy contexts have drained.

## Rollback

Roll the writer stop back to the Phase B release target above to restore dual
emission. Leave both namespace routes, both environment readers, both
token-scope verifiers, the Zero CLI alias, both Desktop identities, stored
callbacks, queued contexts, and immutable historical artifacts in place.
Release and production verification remain separate from this implementation
change.
