# Welcome chat thread creation

S1 of [#33205](https://github.com/vm0-ai/vm0/issues/33205), implemented for
[#33252](https://github.com/vm0-ai/vm0/issues/33252), provides a server operation
for an explicit welcome action. S2 of [#33294](https://github.com/vm0-ai/vm0/issues/33294)
exposes it in Settings > Debug and recognizes the original official examples
through ordinary Markdown Artifact previews.

## Manual Debug action

The existing Debug gate and `welcomeThread` switch control the card. A deliberate
click calls the atomic endpoint below, retains its UUID through retries, catches
up the ordinary thread list, then closes Settings and opens the returned chat.
The action belongs to the initiating user, workspace, page and open dialog.
Dismissal cancels it immediately even while the dialog's closing animation is
still running. Cancellation does not undo a transaction committed by the server.

The shared chat URL recognizer accepts exact example URLs from the existing
illustration, presentation and video template catalogs. It does not trust a
static-host prefix or require a run/uploaded Artifact record. Ordinary Markdown
links and image syntax keep their existing lightbox/card behavior; the server's
complete localized welcome content is unchanged.

## API contract

`welcomeChatThreadsContract` in `@okouai/api-contracts/contracts/welcome-chat-threads`:

```http
POST /api/welcome-chat-threads
Content-Type: application/json

{"clientThreadId":"<UUID for this deliberate action>"}
```

The body is strict. The authenticated context supplies the member and active
workspace. Session/PAT authentication follows ordinary chat creation; agent
credentials require the existing `chat-thread:write` capability and membership.
The server resolves its effective `FeatureSwitchKey.WelcomeThread`
(`welcomeThread`) value, including persisted workspace/member overrides. The
registry is disabled for everyone by default.

| Status | Body / meaning                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| `201`  | `{ "id": "<real thread UUID>" }`, for both initial creation and valid replay                                  |
| `400`  | Standard error envelope; malformed request or invalid connector selection                                     |
| `401`  | Missing authentication or active workspace/membership                                                         |
| `403`  | Missing capability or disabled welcome switch                                                                 |
| `404`  | `NOT_FOUND`; an occupied ID is not accessible to this member in this workspace                                |
| `409`  | `DEFAULT_AGENT_NOT_READY`; the workspace default agent is unavailable or inaccessible; configure it and retry |
| `409`  | `CONFLICT`; an owned ordinary thread occupies this action ID without welcome provenance                       |
| `500`  | Unexpected dependency/storage failure; no partial welcome is committed                                        |

Retain one `clientThreadId` while retrying an action, including after a lost
response. A later intentional click uses a new UUID. This is not a permanent
once-per-member receipt. The caller does not supply an agent, model, locale,
brand, welcome text, or connector grants.

## Persistence and replay

The existing default agent reference is resolved in its owning workspace and
must be visible to the member. No agent is provisioned. The normal model-first
default resolver and service-tier policy select the initial pin; `null` remains
a valid unresolved model. Media defaults and initial sparse connector
selections follow ordinary thread creation. No model or credit admission is
needed to insert the welcome.

One transaction creates the ordinary personal thread, initial connector
selections, canonical `created` lifecycle event, and one canonical
`output.message`. The message has sequence 1 and no run. The shared
`createChatThreadInTransaction` primitive keeps the ordinary create caller's
existing transaction and conflict behavior.

The welcome seed uses a permanent server UUID namespace, independent of locale
and template version. An insert conflict waits for the winning transaction;
the loser then authorizes that stored thread and verifies its seed through the
standard repeatable-read snapshot plus PostgreSQL history. Hot-row retention
does not erase provenance. Replay does not compare or rewrite current template
text, titles, model selections, or stored locale. Expected deletion during a
retry returns the ordinary missing-thread outcome.

Thread-list and message notifications are published after commit, including on
replay. Refresh/reconnect use the ordinary snapshot, raw rows, and catch-up
contracts. The CLI's existing history synchronization can retrieve the same
runless message. Later replies, model selection, rename, and deletion use the
ordinary APIs; disabling the welcome switch does not gate those operations.

## Content and compatibility

The server-only `WELCOME_THREAD_TEMPLATE` source constant records version 1.
Its ten locale resources preserve the approved original copy at
`ae8708dbff466a35614f17d83bd849eee81f1ce7`. The existing member locale contract
applies, with `en-US` for an absent preference. Public assistant identity comes
from `PUBLIC_BRAND_PRESENTATION`, independently of editable agent metadata.

The only content adaptations are the accurate `.jpg` and `.html` file labels,
and ordinary Mermaid flowcharts replacing the two welcome-only team/Slack
diagram cards. All three official sample URLs, the automation table, team
instructions, Slack guidance, and closing links are retained. App/setup/invite
links derive from `APP_URL`; docs use the established service-origin resolver.
These are fixed examples, with no remote content fetch or generation.

The endpoint and switch are additive. Existing frontend/API/Runner consumers
keep their contracts, and existing readers understand the canonical runless
message. A new caller reaching an API that predates this endpoint gets a
missing route; S2 must respect its feature gate. There is no schema migration,
historical rewrite, new event-envelope field, automatic lifecycle hook, queued
prompt, run, workflow execution, or generation charge.

S2 must add the Debug entry and shared preview recognition for the official
`static.vm0.io/vm0/artifact-templates/...` URLs. This slice does not restore the
retired welcome page or renderer and does not enable a production rollout.
