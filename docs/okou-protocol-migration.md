# Okou protocol migration

This document records the Phase B protocol contract for issues #26487 and
#26490. Phase A compatibility is live at release target
`2eba4f48e1b1bbcce818f4b8a6c8f717c28f7006`.

## Canonical and compatibility surfaces

Current first-party Platform, private CLI, Zero Desktop, and Okou Desktop
clients send branded requests through `/api/okou/**`. Active typed contracts
also use that namespace. The API registration and runtime-schema layers still
publish the same handlers and schemas through `/api/zero/**` for older clients,
pinned CLI artifacts, installed Desktop builds, and stored callback URLs.

Current consumers prefer `OKOU_*` variables and fall back to their `ZERO_*`
aliases. Every new Zero-agent run emits both `OKOU_APP_URL` and `ZERO_APP_URL`,
both agent and optional chat-thread identifier names, and two independent
run-token secrets:

- `OKOU_TOKEN` has `scope: "okou"`.
- `ZERO_TOKEN` has `scope: "zero"`.

The tokens retain the existing sandbox prefix and equivalent identity,
organization, run, capability, optional Computer Use host, optional browser,
issued-at, and expiry claims. They are signed separately and therefore have
different values. Token values remain inside the existing secret boundary and
must not be logged, rendered into prompts, telemetry, snapshots, or PR text.

## Compose and queued-context compatibility

The API-authored canonical agent compose remains unchanged, so Phase B does not
change its content-addressed hash. The run builder emits both branded families
independently of compose templates. Existing compose versions, old APIs after a
rollback, draining runtimes, and pinned CLI artifacts therefore keep working
without rewriting persisted compose content.

Already-stored queued and active execution contexts are not rewritten. New
contexts contain both families. This preserves old guest/runtime consumers
while allowing current runtimes to select the canonical Okou variables.

## Rollback

Roll Phase B clients and emitters back to the Phase A release target above.
Leave both namespace routes, both environment readers, both token-scope
verifiers, the Zero CLI alias, both Desktop identities, stored callbacks, and
immutable historical artifacts in place. Release and production verification
are separate from this implementation change.
