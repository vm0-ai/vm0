# API BDD Coverage Plan

This document is the migration target for the existing API Vitest suite. It is not a marketing-level workflow summary: every legacy test family must map to a BDD case group, a service-level exception, or an explicit drop decision.

The current inventory is 3344 `it`/`test` declarations under `turbo/apps/api/src` with `it.each` declarations counted once. Actual Vitest execution count may be higher after parameter expansion.

## Migration Status

Coverage parity is a hard gate: new BDD tests must restore per-file coverage **before** the corresponding legacy tests are deleted. An earlier phase of this branch deleted the legacy suite ahead of parity; that was reverted. The branch now carries:

- All legacy test files restored from `main`, alive until their route family has a BDD replacement with per-file coverage >= baseline.
- All production source files identical to `main` (this effort touches test code only; knip-driven production cleanups were reverted together with the test restore).
- The 13 service-level exception files (listed below) restored and kept as-is.
- The 11 `*.bdd.test.ts` files plus `helpers/api-bdd*.ts`, which already exceed the `main` coverage baseline when combined with the legacy suite.

Per-round workflow from here: complete BDD coverage for one route family, prove per-file parity for that family's source files, then delete that family's legacy tests in the same commit.

Known coverage jitter (not regressions): `src/signals/services/agent-run-create.service.ts` and `src/signals/services/local-day.ts` fluctuate by a few covered statements between identical runs because some branches depend on wall-clock day boundaries.

## Test Principles

- Test API behavior through the Hono app and ts-rest contracts.
- Construct state through API requests when a route exists.
- Use helper functions only as API clients, not as direct database writers.
- Mock only external services: Clerk, Stripe, Slack, Telegram, GitHub, OpenAI, Axiom, S3/R2, Plain, provider APIs, and webhook senders.
- Use the real database behind the API.
- Do not assert database rows in BDD tests.
- Assert state through response bodies, follow-up GET/list/status routes, artifact/file reads, billing/usage reads, integration status reads, runner poll/claim responses, or external-provider mock state.
- Keep service-level tests only when route-level coverage would be impossible or less meaningful.
- Prefer chained scenarios when setup is expensive and the later assertions are part of the same user journey.

## Helper Contract

BDD helpers should be thin wrappers over route calls:

- Auth helpers: `signInAsUser`, `signInAsOrgAdmin`, `signInAsOrgMember`, `createCliToken`, `createSandboxToken`, `createZeroToken`, `createRunToken`.
- Organization helpers: `readMe`, `readOrg`, `listOrgs`, `inviteMember`, `requestMembership`, `listMembers`, `updateOrg`, `uploadOrgLogo`.
- Agent and compose helpers: `createAgent`, `readAgent`, `listAgents`, `updateAgent`, `deleteAgent`, `setDefaultAgent`, `createCompose`, `readCompose`, `listComposes`.
- Run helpers: `createRun`, `readRun`, `readRunContext`, `readRunQueue`, `cancelRun`, `createCheckpoint`, `readCheckpoint`, `runnerHeartbeat`, `runnerPoll`, `runnerClaim`, `completeRun`.
- Chat helpers: `createThread`, `readThread`, `listThreads`, `sendMessage`, `readMessages`, `searchThreads`, `readThreadArtifacts`.
- Connector helpers: `listConnectors`, `searchConnectors`, `readConnectorByType`, `startOAuth`, `completeOAuth`, `connectManualGrant`, `createCustomConnector`, `setConnectorSecret`, `deleteConnectorSecret`, `readIntegrationStatus`.
- Billing and usage helpers: `readBillingStatus`, `startCheckout`, `openPortal`, `redeemCredit`, `readUsage`, `readUsageMembers`, `readUsageRuns`, `readInsights`, `runUsageCron`.
- File and media helpers: `prepareUpload`, `completeUpload`, `readFile`, `readArtifact`, `readHostedContent`, `startImageGeneration`, `startVideoGeneration`, `startVoiceGeneration`, `readGenerationStatus`.
- Schedule and webhook helpers: `createSchedule`, `readSchedule`, `listSchedules`, `enableSchedule`, `disableSchedule`, `runSchedule`, `deleteSchedule`, `postSignedCallback`, `postSignedWebhook`.

If a helper cannot be implemented with API calls, mark the BDD case as `needs visible API/helper` and do not silently fall back to direct database setup.

## Case Groups

### AUTH-01: Current user and organization identity

Given an authenticated user with an active organization
When the user calls the current-user API
Then the response includes the user, organization, permissions, and safe preference fields.
Then routes requiring an organization accept the same session.
Then routes requiring an organization reject a session with no active organization.

Coverage: `auth-me`, `health-auth-probe`, user preferences, user model preference, permission grants, current organization identity, no-organization cases.

### AUTH-02: Token issuance, capabilities, expiry, and revocation

Given a user creates CLI, device, sandbox, zero, and run-scoped tokens through API flows
When those tokens are used against matching route families
Then accepted capabilities succeed.
Then missing, expired, mismatched, or revoked capabilities return unauthorized or forbidden.
Then follow-up token list/status APIs show only safe token metadata.

Coverage: `cli-auth`, `device-token`, `desktop-auth`, `zero-api-keys`, `zero-api-keys-delete`, `zero-realtime-token`, auth token service exception cases.

### AUTH-03: User-owned configuration

Given an authenticated user manages API keys, secrets, variables, preferences, connectors, and push subscriptions through APIs
When the user creates, lists, updates, and deletes those resources
Then follow-up GET/list routes expose safe metadata and never raw secret values.
Then invalid names, duplicate names, unsupported scopes, and cross-user access are rejected.

Coverage: `zero-secrets`, `zero-secrets-delete`, `zero-variables`, `zero-variables-delete`, `zero-user-connectors`, `zero-user-connectors-update`, `zero-user-preferences`, `zero-user-model-preference`, `zero-push-subscriptions`.

### ORG-01: Organization lifecycle and metadata

Given an org admin manages organization metadata through API routes
When the admin reads, updates, deletes, lists, and uploads logo metadata
Then the visible org/list/logo responses reflect the change.
Then non-admin, no-org, and cross-org callers are rejected.

Coverage: `zero-org`, `zero-org-list`, `zero-org-delete`, `zero-org-logo`, `zero-team`.

### ORG-02: Organization membership and invitations

Given an org admin and member use membership APIs
When the admin invites users, lists members, handles membership requests, and changes roles
Then member/list/request APIs expose the expected state.
Then non-admins cannot perform admin-only changes.
Then cross-org requests do not leak member or invitation existence.

Coverage: `zero-org-members`, `zero-org-invite`, `zero-org-membership-requests`.

### ORG-03: Onboarding and first-run setup

Given a new authenticated user completes onboarding setup
When they read onboarding status, org state, default resources, connectors, and agents
Then setup is complete and idempotent.
Then repeated setup does not create duplicate visible resources.
Then skipped or invalid setup returns client errors without changing visible state.

Coverage: `zero-onboarding-setup`, `zero-onboarding-status`.

### AGENT-01: Agent lifecycle and isolation

Given an org user creates an agent through the API
When they read, list, update, and delete it
Then each mutation is visible through agent GET/list responses.
Then invalid payloads, missing agents, private agents, and cross-org agents return the expected errors.

Coverage: `zero-agents`, `zero-agents-create`, `zero-agents-by-id`, `zero-agents-list`, `zero-agents-update`, `agent-run-telemetry`.

### AGENT-02: Default agent and agent custom connectors

Given an org admin has an agent and custom connectors created through APIs
When the admin sets the default agent and enables or clears agent custom connectors
Then org/default-agent and agent custom connector GET responses show the expected state.
Then non-admin, cross-org, missing-agent, duplicate-default, and cross-org connector cases are rejected.

Coverage: `zero-default-agent`, `zero-agent-custom-connectors`, related org metadata read-after-write cases.

### COMPOSE-01: Compose lifecycle

Given a user creates a compose through API
When they read by id, read by name, list, update metadata, and delete it
Then the compose APIs expose every state transition.
Then deleted, cross-org, duplicate, invalid, and pending-run protected compose cases return the expected responses.

Coverage: `agent-composes-create`, `agent-composes-read`, `agent-composes-metadata`, `agent-composes-delete`, `zero-composes-by-id`, `zero-composes-by-name`, `zero-composes-list`, `zero-composes-metadata-update`, `zero-composes-delete`.

### RUN-01: Run creation admission and validation

Given a user has an agent, organization membership, model provider state, billing status, and optional session state created through APIs
When the user creates a run
Then the run response contains the run id, status, queue state, and visible metadata.
Then invalid bodies, ambiguous tool entries, invalid provider pinning, missing compose/session, missing credits, suspended orgs, and concurrency limits return the expected errors.

Coverage: `zero-runs-create`, `agent-runs-create`, zero-run admission service tests, built-in admission service tests.

### RUN-02: Run context, secrets, providers, connectors, grants, and skills

Given provider credentials, connector credentials, custom connectors, secrets, variables, grants, skills, memory, and volumes are configured through APIs
When the user creates a run
Then GET run context exposes only safe placeholders and non-secret execution metadata.
Then expired, revoked, missing, ungranted, cross-user, and cross-org credentials are omitted or rejected.
Then provider selection and default-provider behavior are visible through run context or subsequent run state.

Coverage: `zero-run-context`, `zero-runs-runner`, `zero-skills`, `zero-model-providers`, `zero-me-model-providers-*`, `zero-model-policies`, `zero-connector-data.service`.

### RUN-03: Runner dispatch and lifecycle

Given runners register and heartbeat through runner APIs
When runs are created, queued, polled, claimed, completed, failed, or cancelled
Then runner poll/claim responses and GET run/queue endpoints expose dispatch, target runner, terminal state, cancellation, and queue position.
Then stale runners, duplicate sessions, capacity limits, and unauthorized runner actions are rejected.

Coverage: `runners`, `zero-runs-queue`, `zero-queue-position`, `zero-runs-cancel`, `agent-runs-cancel`, runner dispatch service tests.

### RUN-04: Sessions, checkpoints, logs, and network logs

Given a user has a session with runs, checkpoints, logs, and network logs
When the user reads sessions, checkpoints, logs, network logs, and run detail endpoints
Then owned resources are returned.
Then missing, cross-user, cross-org, unauthorized, malformed id, and pagination cases return the expected responses.

Coverage: `agent-sessions-id`, `agent-checkpoints-id`, `zero-runs-by-id`, `agent-runs-read`, `zero-run-network-logs`, `zero-logs-list`, `zero-logs-get-by-id`, `zero-logs-search`, `logs-search`.

### CHAT-01: Chat thread lifecycle

Given a user creates a chat thread
When they list, read, rename, patch, pin, unpin, mark read, update model selection, delete, and search
Then thread GET/list/search responses expose the expected thread state.
Then missing, malformed, cross-user, cross-org, and deleted threads are hidden or rejected.

Coverage: `zero-chat-threads`, `chat-threads-v1`, `zero-chat-threads-create`, `zero-chat-threads-list`, `zero-chat-threads-rename`, `zero-chat-threads-patch`, `zero-chat-threads-pin`, `zero-chat-threads-unpin`, `zero-chat-threads-mark-read`, `zero-chat-threads-model-selection`, `zero-chat-search`, `zero-chat-threads-delete`, `zero-chat-threads-github-prs`.

### CHAT-02: Chat messages and callbacks

Given a thread is connected to a run
When user messages, assistant callback messages, integration messages, and event-consumer messages are posted
Then message GET/list responses expose visible text, attachments, status, pagination, and ordering.
Then invalid signatures, malformed payloads, blank messages, missing threads, and cross-org attempts are rejected or ignored.

Coverage: `zero-chat-messages`, `zero-chat-threads-messages`, `internal-callbacks-chat`, `internal-event-consumers`, `internal-event-consumers-telegram-typing`.

### CHAT-03: Artifacts and memory

Given a run or chat thread produces artifacts and memory updates through APIs or callbacks
When the user reads thread artifacts, artifact sync, memory, memory activity, and memory summaries
Then only user-visible artifacts and memory state are returned.
Then stale, deleted, malformed, cross-user, and cross-org resources are omitted or rejected.

Coverage: `zero-chat-threads-artifacts`, `zero-chat-threads-artifacts-sync`, `zero-memory`, `zero-memory-activity`, memory diff service tests, memory summarize service tests.

### CONN-01: Connector discovery and by-type access

Given connector definitions, feature switches, provider mocks, and auth state are configured
When a user lists, searches, reads by type, computes scopes, or deletes by type
Then connector GET/list/search responses reflect available, configured, gated, and missing connectors.
Then no secret values are returned.

Coverage: `zero-connectors-list`, `zero-connectors-search`, `zero-connectors-by-type-get`, `zero-connectors-by-type-delete`, `zero-connectors-scope-diff`, `zero-feature-switches`.

### CONN-02: OAuth start, callback, device auth, and manual grants

Given a user starts connector OAuth, device auth, or manual grant flows through API routes
When provider callbacks succeed, fail, expire, replay, or race
Then connector status/list responses show connected, pending, failed, or disconnected state.
Then invalid state, wrong connector type, expired state, duplicate claim, unsupported scopes, and non-admin org-scope attempts are rejected.

Coverage: `connectors-type-callback`, `zero-connectors-oauth-start`, `zero-connectors-oauth-device-auth`, `zero-connectors-manual-grant-connect`, `github-oauth`, `zero-codex-device-auth`, `zero-claude-code-device-auth`, `connector-oauth-state.service`, `test-oauth-provider-get`.

### CONN-03: Custom connectors and connector-owned secrets

Given an org user creates custom connectors through API routes
When they create, patch, set secrets, delete secrets, enable for agents, and delete connectors
Then connector detail/list and agent connector APIs expose safe metadata only.
Then secret values, encrypted envelope details, and internal variable rows are not asserted in BDD.
Then invalid schema, duplicate names, cross-org ids, and unsupported auth methods are rejected.

Coverage: `zero-custom-connectors`, `zero-custom-connectors-create`, `zero-custom-connectors-patch`, `zero-custom-connectors-secret-set`, `zero-custom-connectors-secret-delete`, `zero-custom-connectors-delete`.

### INT-01: Slack integration and Slack app routes

Given Slack external mocks and an authenticated org are configured
When the user connects Slack, lists channels, handles OAuth, browser connect, commands, events, interactions, upload init/complete, status, and message routes
Then Slack status/integration APIs and chat/file APIs show linked state and visible side effects.
Then invalid signatures, missing installs, missing scopes, non-admin calls, and Slack provider errors return expected responses.

Coverage: `zero-integrations-slack`, `zero-integrations-slack-status`, `zero-integrations-slack-message`, `zero-integrations-slack-upload-init`, `zero-integrations-slack-upload-complete`, `zero-slack-connect`, `zero-slack-oauth`, `zero-slack-browser-connect`, `zero-slack-channels`, `zero-slack-commands`, `zero-slack-events`, `zero-slack-interactive`, `test-slack-*`, `internal-callbacks-slack-org`.

### INT-02: Telegram integration

Given Telegram external mocks and an authenticated user are configured
When the user links, patches, deletes, posts messages, initializes uploads, completes uploads, receives integration messages, and runs cleanup
Then Telegram integration/status APIs and chat/file APIs expose linked state and visible side effects.
Then invalid auth, missing chats, stale sessions, invalid state, and provider errors return expected responses.

Coverage: `zero-integrations-telegram`, `zero-integrations-telegram-post`, `zero-integrations-telegram-message`, `zero-integrations-telegram-upload-init`, `zero-integrations-telegram-upload-complete`, `integrations-telegram-delete`, `integrations-telegram-patch`, `test-telegram-*`, `zero-telegram-data.service`, `internal-callbacks-telegram`, `cron-telegram-cleanup`.

### INT-03: GitHub and AgentPhone integrations

Given GitHub or AgentPhone provider mocks and an authenticated org are configured
When the user connects, reads, patches, deletes, lists files, configures label listeners, links AgentPhone, or updates routes
Then integration GET/status/list APIs expose the expected state.
Then admin-only, cross-org, missing install, provider error, and disconnect cases return expected responses.

Coverage: `integrations-github-*`, `zero-integrations-github-files`, `internal-callbacks-github-issues`, `zero-integrations-agentphone-link`, `zero-integrations-agentphone-routes`.

### BILL-01: Billing status and Stripe-backed actions

Given a user has visible billing state and Stripe mocks are configured
When they request billing status, checkout, portal, restore, downgrade, auto-recharge, redeem, redeem-code, and invoices
Then response bodies and follow-up billing/invoice GET responses show the expected visible state.
Then invalid code, missing customer, suspended org, non-admin, and provider failure cases return expected errors.

Coverage: `zero-billing-status`, `zero-billing-checkout`, `zero-billing-portal`, `zero-billing-restore`, `zero-billing-downgrade`, `zero-billing-auto-recharge`, `zero-billing-redeem`, `zero-billing-redeem-code`, `zero-billing-invoices`.

### BILL-02: Usage, insights, attribution, maps, banking, and model stats

Given product actions create usage through run, media, maps, banking, and generation APIs
When usage processing and aggregation cron routes run
Then usage, usage members, usage runs, usage record, usage insight, insights, model stats, attribution, maps, and banking APIs return expected totals and scoped data.
Then cross-org, stale member, missing pricing, insufficient credit, and disabled feature cases return expected responses.

Coverage: `usage`, `zero-usage-record`, `zero-usage-runs`, `zero-usage-members`, `zero-usage-insight`, `zero-insights`, `model-stats`, `zero-attribution`, `zero-maps`, `zero-banking`, `cron-aggregate-usage`, `cron-process-usage-events`, `cron-aggregate-insights`.

### FILE-01: Uploads, storage, host, and legacy files

Given an authenticated user prepares uploads, completes uploads, writes storage, and hosts artifacts through API routes
When they read files, hosted content, storage content, and legacy file routes
Then owner-visible content is returned.
Then cross-user, cross-org, unsupported content type, invalid filename, missing object, stale version, and missing capability cases are rejected.

Coverage: `zero-uploads-prepare`, `zero-uploads-complete`, `storages`, `storages-write`, `zero-host`, `zero-web-download`, `legacy-file`.

### FILE-02: Image, video, voice, audio, and built-in generation

Given a user starts image, video, voice, audio transcription, generate-image, or built-in generation through API routes
When external providers succeed, fail, time out, or return usage metadata
Then generation status, file/artifact, billing, and usage APIs expose the final visible state.
Then unauthorized tokens, missing capability, unsupported options, missing pricing, insufficient credits, active-generation limits, and provider failures return expected responses.

Coverage: `zero-image-io-generate`, `zero-video-io-generate`, `zero-voice-io-post`, `zero-voice-io-quota`, `audio-transcriptions-v1`, `generate-image`, `zero-built-in-generation`, `webhooks-built-in-generations`.

### FILE-03: Desktop computer-use runtime

Given a Desktop app host starts and heartbeats
When commands are queued, claimed, completed, screenshot-proxied, or cleaned up
Then host, command, screenshot, cleanup, and artifact APIs expose the expected state.
Then stale hosts, duplicate active hosts, unauthorized screenshots, missing capability, and invalid cleanup auth are rejected.

Coverage: `zero-computer-use`.

### SCHED-01: Schedule lifecycle

Given a user creates a schedule for an agent or compose through API routes
When they list, read, enable, disable, manually run, and delete the schedule
Then schedule GET/list responses expose every transition.
Then invalid cron, invalid body, missing schedule, cross-org schedule, active previous run, and missing capability cases return expected responses.

Coverage: `zero-schedules`, `zero-schedules-enable`, `zero-schedules-disable`, `zero-schedules-run`, `zero-schedules-delete`, `zero-schedules.service`.

### SCHED-02: Cron routes

Given cron authorization is valid
When cleanup, aggregation, email, schedule execution, usage processing, billing reconciliation, memory summarize, skill sync, and Telegram cleanup cron routes run
Then route responses report work done.
Then follow-up public or internal GET/status endpoints expose visible side effects.
Then missing or invalid cron auth is rejected.

Coverage: `cron-cleanup-sandboxes`, `cron-aggregate-usage`, `cron-aggregate-insights`, `cron-drain-email-outbox`, `cron-execute-schedules`, `cron-process-usage-events`, `cron-reconcile-billing-entitlements`, `cron-summarize-memory`, `cron-sync-skills`, `cron-telegram-cleanup`.

### HOOK-01: Signed internal callbacks

Given signed internal callback requests are constructed for agent, chat, schedule, Slack org, Telegram, and GitHub issue flows
When valid callback payloads are posted
Then response bodies and follow-up run/chat/integration/status APIs expose the side effect.
Then invalid signatures, expired timestamps, malformed payloads, missing callbacks, missing installs, and provider failures return expected responses.

Coverage: `callback-route`, `internal-callbacks-agent`, `internal-callbacks-chat`, `internal-callbacks-schedule`, `internal-callbacks-slack-org`, `internal-callbacks-telegram`, `internal-callbacks-github-issues`.

### HOOK-02: External webhooks

Given webhook payloads from third-party, agent, automation, storage, events, checkpoints, complete, firewall auth, and health usage telemetry providers
When valid signed webhook requests are posted
Then response bodies and follow-up GET/status APIs expose the visible side effects.
Then invalid signatures, malformed payloads, replay, missing entities, provider errors, and unauthorized requests are rejected.

Coverage: `webhooks-third-party`, `webhooks-agent-firewall-auth`, `webhooks-agent-health-usage-telemetry`, `webhooks-agent-checkpoints`, `webhooks-agent-complete`, `webhooks-agent-events`, `webhooks-agent-storage`, `webhooks-automation`, `webhook-automations`.

### OPS-01: Logs, email, support, skills, feature switches, and health

Given users and internal actors exercise logs, email, developer support, skills, feature switches, report error, health, and unsubscribe routes
When they create, list, search, download, unsubscribe, report, or check status
Then the corresponding GET/list/status responses or external provider mock states expose the user-visible result.
Then auth, invalid payload, cross-org, provider failure, malformed archive, missing resource, and disabled feature cases return expected responses.

Coverage: `zero-logs-*`, `logs-search`, `zero-email`, `email-unsubscribe`, `zero-developer-support`, `zero-report-error`, `zero-skills`, `zero-feature-switches`, `health`, `health-auth-probe`, `user-export`.

### OPS-02: Platform, compatibility, and instrumentation

Given app-level API requests, compatibility config, cron config, and telemetry config
When the app handles registered routes, unmatched routes, CORS, proxy fallback, thrown errors, instrumentation, release graph, and cron config checks
Then HTTP responses, config checks, and boundary initialization behavior match the API contract.

Coverage: `app-factory`, `instrument`, `release-please-config`, `vercel-crons`, `web-api-compatibility`.

## Chained Scenario Candidates

Use these when setup dominates runtime. Each chain should be one test case with multiple visible Then assertions, not a sequence of independent tests sharing hidden mutable state.

### CHAIN-AGENT: Org onboarding to default agent

Given an org admin signs in and completes onboarding
When the admin creates an agent
Then agent list/detail returns the agent.
Then default-agent update succeeds.
Then org/default-agent read returns the selected agent.
Then agent update/delete changes later reads as expected.

### CHAIN-RUN: Provider, connector, run, runner, usage

Given one org, billing status, model provider, connector, secret, grant, agent, and runner heartbeat are created through APIs
When the user creates a run
Then GET run verifies creation.
Then GET run context verifies safe provider and connector projection.
Then runner poll verifies dispatch.
Then cancel or complete verifies terminal state.
Then usage/billing reads verify charge effects.

### CHAIN-CHAT: Thread to run to callback to artifacts

Given a user creates a chat thread
When the user sends a message that creates or references a run
Then message list includes the user message.
Then run GET exposes the run.
Then signed callback ingestion appends assistant output.
Then artifact and memory APIs expose produced output.
Then thread list/search reflects the final thread.

### CHAIN-CONNECTOR: OAuth connector to run context

Given a user starts and completes OAuth for a connector
When the user grants the connector to an agent and creates a run
Then connector status APIs show connected state.
Then GET run context shows safe connector placeholders.
Then revoking or expiring the connector changes the next run context.

### CHAIN-BILLING-MEDIA: Paid generation and quota

Given billing status and provider pricing are configured through visible helpers
When the user starts image, video, voice, maps, or built-in generation
Then generation status and artifact/file reads expose completion.
Then usage/billing reads expose settlement.
Then a request over quota or without credits is rejected.

### CHAIN-FILE: Upload to hosted artifact

Given one authenticated user and a run are created through APIs
When the user prepares and completes an upload
Then file read returns the content.
Then hosted content and artifact APIs expose the file.
Then cross-user reads are denied.

### CHAIN-SCHEDULE: Schedule lifecycle to run execution

Given a user creates an agent and schedule
When the schedule is enabled
Then list/read shows it enabled.
Then manual run creates a run visible through GET run.
Then cron execution processes due schedules.
Then disabling and deleting the schedule changes later reads.

## Service-Level Exceptions To Keep

These are not route BDD and should remain focused direct tests:

- `tokens.test.ts`: token parsing, prefixes, expiry, scopes, capability decoding, and feature-switch capability gates.
- `callback-route.test.ts`: shared signed callback wrapper behavior, with real endpoint behavior covered by HOOK cases.
- `internal-api-url.test.ts`: environment precedence for internal callback base URL.
- `sql-span-name.test.ts`: SQL span-name parser.
- `time.test.ts`: test-only time helper.
- `log.test.ts`: Axiom logging adapter, serialization, and flush behavior.
- `axiom-datasets.test.ts`: Axiom token routing by dataset/APL.
- `route.test.ts`: Hono signal route wrapper behavior.
- `codex-auth-json-parser.test.ts`: parser behavior for external auth JSON.
- `crypto.utils.test.ts`: encryption envelope compatibility and KMS boundary behavior.
- `memory-activity-diff.service.test.ts`: memory diff algorithm behavior.
- `memory-activity-summarize.service.test.ts`: prompt rendering and budget behavior.
- `zero-schedules.service.test.ts`: cron next-run calculation.

Service tests not listed above should migrate toward API BDD unless a later audit proves there is no useful route surface.

## Drop Decisions

Drop only after confirming the behavior is covered by a BDD case above:

- Duplicate unauthenticated/no-org tests inside every route file when a route-family auth matrix covers the behavior.
- Direct database read-after-write assertions when a GET/list/status route can verify the same state.
- Direct database cleanup assertions.
- Internal ccstate command call assertions.
- Ably publish call assertions when runner poll/claim can verify dispatch.
- Secret encryption/decryption assertions inside route tests; keep crypto coverage in the service exception.
- Provider call-count assertions that do not affect visible provider contract or API state.
- Storage row, pointer, tombstone, ledger, queue, and membership row shape assertions when visible APIs prove the outcome.

## Source Family Coverage Matrix

| Source family                                                  | Legacy cases | BDD mapping                                   | Decision                                                    |
| -------------------------------------------------------------- | -----------: | --------------------------------------------- | ----------------------------------------------------------- |
| Connectors, OAuth, Slack, Telegram, GitHub, AgentPhone         |          770 | CONN-01..03, INT-01..03, CHAIN-CONNECTOR      | Keep/merge through API status and provider boundary mocks   |
| Cron, internal callbacks, webhooks, schedules                  |          605 | SCHED-01..02, HOOK-01..02, CHAIN-SCHEDULE     | Keep/merge through signed HTTP requests and follow-up reads |
| Auth, users, organizations, onboarding, keys, preferences      |          390 | AUTH-01..03, ORG-01..03                       | Keep/merge through auth/org/user APIs                       |
| Billing, usage, insights, models, maps, banking                |          297 | BILL-01..02, RUN-01..02, CHAIN-BILLING-MEDIA  | Keep/merge through billing/usage/status APIs                |
| Logs, skills, email, report, support, feature switches, health |          281 | OPS-01                                        | Keep/merge; provider assertions only at boundary            |
| Chat, messages, memory, artifacts                              |          245 | CHAT-01..03, CHAIN-CHAT                       | Keep/merge through thread/message/artifact/memory APIs      |
| Runs, runner runtime, checkpoints                              |          238 | RUN-01..04, CHAIN-RUN                         | Keep/merge through run/context/runner/queue APIs            |
| Agents, composes, default agent                                |          179 | AGENT-01..02, COMPOSE-01, CHAIN-AGENT         | Keep/merge through agent/compose/org reads                  |
| Files, uploads, storage, host, media, computer-use             |          178 | FILE-01..03, CHAIN-FILE, CHAIN-BILLING-MEDIA  | Keep/merge through file/artifact/status APIs                |
| Service exceptions and service migrations                      |          136 | Service exceptions list plus API BDD mappings | Keep listed exceptions; migrate the rest                    |
| Platform/static app behavior                                   |           25 | OPS-02                                        | Keep focused boundary/static checks                         |

## Migration Audit — Deleted Legacy Families

Legacy test files deleted after verifying full-suite per-file coverage stayed >= the main baseline without them (only the documented wall-clock jitter files differ):

| Deleted legacy file                                                                                    | BDD replacement                                                                   | Verified by                          |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------ |
| `health.test.ts`                                                                                       | OPS-02 in `hooks-ops.bdd.test.ts`                                                 | full-suite per-file diff vs baseline |
| `zero-feature-switches.test.ts`                                                                        | OPS-01 in `hooks-ops.bdd.test.ts`                                                 | same                                 |
| `zero-chat-threads-pin.test.ts`, `zero-chat-threads-unpin.test.ts`, `zero-chat-threads-rename.test.ts` | CHAT-01 mutation chain in `chat-files.bdd.test.ts`                                | same                                 |
| `zero-voice-io-quota.test.ts`                                                                          | FILE-02 in `billing-usage-media.bdd.test.ts`                                      | same                                 |
| `zero-me-model-providers-list.test.ts`                                                                 | MISC-04 in `misc-routes.bdd.test.ts`                                              | same                                 |
| `desktop-auth.test.ts`                                                                                 | AUTH-02 in `auth-device.bdd.test.ts`                                              | same                                 |
| `cron-telegram-cleanup.test.ts`                                                                        | SCHED-02 safe-cron chain in `runs-schedules.bdd.test.ts`                          | same                                 |
| `zero-integrations-telegram-upload-init.test.ts`                                                       | INT-02 in `integrations.bdd.test.ts`                                              | same                                 |
| `email-unsubscribe.test.ts`                                                                            | MISC-02 in `misc-routes.bdd.test.ts`                                              | same                                 |
| `zero-realtime-token.test.ts`                                                                          | AUTH-02 realtime token in `auth-device.bdd.test.ts` plus run-lifecycle publishes  | same                                 |
| `cron-aggregate-usage.test.ts`                                                                         | SCHED-02 safe-cron chain plus entitled usage reads in `run-lifecycle.bdd.test.ts` | same                                 |

Candidates whose primary route file is BDD-covered but whose deletion regressed collateral service files (kept alive; the regression shows what the next BDD round must cover first): `zero-slack-{events,commands,interactive}` (zero-slack-webhooks.service), `zero-connectors-external-code`, `zero-connectors-oauth-device-auth`, `zero-{codex,claude-code}-device-auth` (device-auth services), `zero-custom-connectors*` (zero-connector-data.service), `zero-memory` (zero-memory-detail.service), `webhooks-agent-events` (optional event-consumer loop, -3), `zero-usage-members` (member totals mapping, -1), `cron-{execute-schedules,reconcile-billing-entitlements,drain-email-outbox}`, `zero-onboarding-status` (-2), `zero-runs-cancel` (agent-run-callback dispatch, -5).

## Migration Audit Table Template

Before deleting an existing test file, fill this table for that file or route family:

| Existing case group           | Target BDD id                    | Decision                       | Replacement assertion                           |
| ----------------------------- | -------------------------------- | ------------------------------ | ----------------------------------------------- |
| Auth/no-org/capability matrix | Matching AUTH/RUN/CONN/etc. case | Merge                          | HTTP status and error body                      |
| Successful mutation           | Matching lifecycle case          | Keep                           | Follow-up GET/list/status                       |
| Direct DB read-after-write    | Matching lifecycle case          | Keep only if visible           | Replace with GET/list/status or mark helper gap |
| Provider call shape           | Boundary contract case           | Keep only if contract-critical | Provider mock state or visible status           |
| Internal algorithm/parser     | Service exception                | Keep narrow                    | Direct focused assertion                        |
| Implementation call count     | None                             | Drop                           | Covered by visible behavior                     |
| No visible assertion exists   | Needs helper/API                 | Block migration                | Add read/status/helper first                    |

## Unreachable Code Candidates

Code paths that cannot be reached through any public API request. Recorded here per #16967; deletion or refactoring is follow-up work, and the resulting
coverage gap is acceptable once listed:

- `agent-webhook-firewall-auth.service.ts` `TOKEN_ACCESS_RESOLUTION_FAILED`: needs a current connector token whose backing secret row is absent; every public seeding path writes both atomically.
- `runners.ts` claim-conflict 409 branches: `claimedAt` is never written (successful claims delete the queue row), so the conflicting state cannot exist.
- `runners.ts` poison-job handling for malformed execution contexts: contexts are always produced schema-valid by the dispatch payload builders.

Production-reachable but not API-constructible (keep the legacy test alive; these are concurrency races, not dead code):

- `agent-webhook-firewall-auth.service.ts` advisory-lock branches (locked refresh divergence, mid-request row deletion, `source-missing` statuses): the legacy test reaches them with pg advisory locks held across requests. `webhooks-agent-firewall-auth.bdd.test.ts` covers the API-reachable surface (the file now exceeds its baseline), but the legacy file stays until a concurrency harness exists.

## Open Helper Gaps

These gaps must be closed before the corresponding old tests can be safely deleted:

- ~~Billing and credit fixture setup that is visible through billing status.~~ Closed: `grantProEntitlement` in `helpers/api-bdd-runs-schedules.ts` moves an onboarded org to the pro tier with credits through the public Stripe `invoice.paid` webhook and verifies via billing status.
- Usage event creation through product APIs plus aggregation cron helpers.
- Run context readers for safe provider, connector, secret, grant, memory, and volume projection.
- Connector OAuth/device-auth lifecycle helpers that expose pending, completed, expired, and replayed state.
- Integration status readers for Slack, Telegram, GitHub, and AgentPhone.
- File/artifact readers for uploads, media generation, built-in generation, hosted content, and screenshots.
- Support/report provider mock state readers where no product GET endpoint exists.
- Push subscription visible state or a test-only notification read helper.
- Org default-agent read API if response-only verification is insufficient.

## Coverage Statement

This BDD file covers the existing 3344 legacy case declarations at the source-family and behavior-group level. It does not authorize deleting tests solely because a broad scenario exists. Deletion or rewrite is safe only after the relevant legacy case group is mapped with the audit table above and either has a visible BDD replacement, is kept as a service exception, or is explicitly dropped as an implementation detail.
