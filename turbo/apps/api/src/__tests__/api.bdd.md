# API BDD Coverage Plan

This document is the migration target for the existing API Vitest suite. It is not a marketing-level workflow summary: every legacy test family must map to a BDD case group, a service-level exception, or an explicit drop decision.

The current inventory is 3344 `it`/`test` declarations under `turbo/apps/api/src` with `it.each` declarations counted once. Actual Vitest execution count may be higher after parameter expansion.

## Migration Status

Coverage parity is a hard gate: new BDD tests must restore per-file coverage **before** the corresponding legacy tests are deleted. The branch now carries the BDD replacement suite and explicit drop/exception notes for legacy cases whose old assertions were implementation detail or not API-constructible.

- The 13 service-level exception files (listed below) restored and kept as-is.
- The 29 `*.bdd.test.ts` files plus `helpers/api-bdd*.ts`, which replace the route-family legacy tests listed below.

Per-round workflow from here: keep new main changes mapped into the BDD suite, prove targeted behavior locally, and let CI validate the full coverage/build matrix.

Known coverage jitter (not regressions): `src/signals/services/agent-run-create.service.ts` and `src/signals/services/local-day.ts` fluctuate by a few covered statements between identical runs because some branches depend on wall-clock day boundaries. Back-to-back full-suite runs on identical code also measured ±2-5 statement swings in `src/lib/slack-connect-blocks.ts`, `src/signals/services/zero-slack-connect.service.ts`, `src/signals/services/webhooks-stripe.service.ts`, `src/signals/services/cron-summarize-memory.service.ts`, and `src/signals/routes/test-slack-state.ts` (timing-dependent detached work; test-slack-state measured 155-162 covered statements across identical runs with its covering legacy test alive). A per-file drop below baseline is therefore adjudicated before being treated as a regression: rerun the full suite, or run the file's covering tests scoped on both sides and compare statement-level hits (`coverage-final.json`); only a loss that persists across runs blocks a round.

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

Coverage: `runs-schedules.bdd.test.ts` for lifecycle/list/enable/disable/delete/run-now/chat-link/capability boundaries; `zero-schedules.service.test.ts` covers cron next-run calculation.

### SCHED-02: Cron routes

Given cron authorization is valid
When cleanup, aggregation, email, schedule execution, usage processing, billing reconciliation, memory summarize, skill sync, and Telegram cleanup cron routes run
Then route responses report work done.
Then follow-up public or internal GET/status endpoints expose visible side effects.
Then missing or invalid cron auth is rejected.

Coverage: `cron-cleanup-sandboxes`, `cron-aggregate-usage`, `cron-aggregate-insights`, `cron-drain-email-outbox`, `cron-execute-automations`, `cron-process-usage-events`, `cron-reconcile-billing-entitlements`, `cron-summarize-memory`, `cron-sync-skills`, `cron-telegram-cleanup`.

### HOOK-01: Signed internal callbacks

Given signed internal callback requests are constructed for agent, chat, schedule, Slack org, Telegram, and GitHub issue flows
When valid callback payloads are posted
Then response bodies and follow-up run/chat/integration/status APIs expose the side effect.
Then invalid signatures, expired timestamps, malformed payloads, missing callbacks, missing installs, and provider failures return expected responses.

Coverage: `callback-route`, `internal-callbacks-agent`, `internal-callbacks-chat`, `internal-callbacks-trigger`, `internal-callbacks-slack-org`, `internal-callbacks-telegram`, `internal-callbacks-github-issues`.

### HOOK-02: External webhooks

Given webhook payloads from third-party, agent, automation, storage, events, checkpoints, complete, firewall auth, and health usage telemetry providers
When valid signed webhook requests are posted
Then response bodies and follow-up GET/status APIs expose the visible side effects.
Then invalid signatures, malformed payloads, replay, missing entities, provider errors, and unauthorized requests are rejected.

Coverage: `webhooks-third-party`, `webhooks-agent-firewall-auth`, `webhooks-agent-health-usage-telemetry`, `webhooks-agent-checkpoints`, `webhooks-agent-complete`, `webhooks-agent-events`, `webhooks-agent-storage`, `webhooks-automation`, automation webhook triggers on `automations-v2`.

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
- Onboarding-status "default agent with no metadata → `defaultAgentMetadata: null`": only the `: null` ternary arm at `onboarding.service.ts:517`; API onboarding always sets `displayName`.
- Onboarding-status it.each "team" tier variant: identical statements to the pro variant; `grantProEntitlement` grants pro only.
- Onboarding-status "cross-org default agent row ignored": `org_metadata.default_agent_id` referencing another org's compose is not API-constructible (`zero-org-default-agent.service.ts` validates org ownership; onboarding only creates own-org agents); the deleted-agent step in the ORG-03 chain covers the identical `return null` statements, and the WHERE org filter is part of the same select statement.
- Memory "scopes to requesting user" foreign-row seeding: replaced by the peer-actor read in the CHAT-03 memory chain (same statements, real API state).
- Email-outbox row shapes (status/attempts/resendId) and sent-row preservation: no API read surface; drain/cleaned response counts plus Resend mock call shapes prove the behavior.
- External-code "commits a completed AWS session when the request aborts after provider success": client-disconnect race against the post-provider commit (`commitSignal` design). The persistence path is statement-identical to the happy-path complete; the abort-true branches it nominally targets never execute because persistence runs on a fresh signal. Dropped as statement-coverage-neutral.

- `connectors-type-callback.test.ts` per-provider `it.each` success/failure matrices (23 providers as of google-search-console): per-provider token/userinfo HTTP shapes are exercised by `packages/connectors`' own suites; the apps/api callback/upsert statements are provider-agnostic and covered by the github, test-oauth, and slack flows in CONN-02.
- Member-role legacy variants that are statement-identical (GitHub get/patch/delete member 403s) merged into one matrix case per route family.
- `zeroRuns.automationId/triggerId` provenance row asserts: no API read surface; the consumer is covered by the alive `internal-callbacks-trigger.test.ts`.
- Automation `automationTriggers.encryptedSecret` roundtrip asserts: dispatch-200-after-create proves it; envelope mechanics stay in the crypto service exception.
- Run-now render-parity it.each across trigger arms: route-level statement-identical; trigger arms held by SCHED-01 run-now and SCHED-02 cron chains in `runs-schedules.bdd.test.ts`.

- Cron-execute-schedules trigger-row asserts: `automation_triggers` rows have no API read surface. Runtime call-sites run inline on paths held by the SCHED-02 chains, the AUTOMATIONS-01 run-now chain, and the SCHED-CB completion-advance chains in `runs-schedules.bdd.test.ts`; row-level trigger callback semantics stay covered by the alive `internal-callbacks-trigger.test.ts`.
- Zero-maps "zero token without maps:read → 403": not API-constructible — `generateZeroToken` grants `maps:read` unconditionally; the capability-mismatch 403 lives in shared auth-context code exercised by the conditional banking/computer-use capabilities elsewhere.
- Zero-host `runUploadedFiles`/`hostedSites`/`hostedDeployments` row asserts: files GET plus complete/redeploy responses and the active-pointer S3 put prove the visible state; hosted-artifact rows have no API read surface for CLI runs. The `artifactKind ?? "hosted-site"` fallback arm is legacy data only — the prepare contract defaults `artifactKind`.
- Computer-use stale-host `revokedAt`/`status`, stored screenshot pointer bucket/key, audit row shape, and cleanup tombstone row asserts → host-list visibility, S3 put-input mock state plus keyless GET pointer, audit-events list API, and GET command `screenshot: {type: "expired"}` reads respectively; legacy DB-seeded org membership for zero tokens → Clerk membership boundary mock. The screenshot-cleanup cron is a global sweep owned solely by `computer-use.bdd.test.ts` (same pattern as email drain / billing reconcile).
- Stripe legacy team price ID variants: statement-neutral (subscription.updated never reads prices); `autoRechargePendingAt` clearing has no API read surface — asserted via the auto-recharge credit grant.

- Storage/version DB row asserts → list/download follow-up reads; sci-notation version-prefix case (statement-identical to the unique-prefix LIKE path); content-change-versionId variant (statement-identical to the v1/v2 chain); per-route storage 401 duplicates → the STOR-04 matrix.
- Model-stats row-shape/count asserts → rankings deltas plus the aggregate window response; alias/`tokens.total`/zero-quantity/unknown-model/connector-provider observation rows are not API-constructible (the webhook canonicalizes to the run's pinned `selectedModel` and the contract enforces `quantity >= 1`); export_jobs row asserts → GET fields plus the S3 put boundary; cooldown+expired combination not API-constructible (`expiresAt = completedAt + 72h`).
- CLI-auth `cli_tokens.name`/cache/metadata row asserts → PAT used on `/me` and org reads; decrypted CHATGPT*\*/TEST_OAUTH*\* secret values stay in the crypto service exception.
- Chat-message Ably/callback-row/decrypted-secret asserts → proxied deliveries and claim env placeholders; thread sticky computer-use host has no read surface — asserted through run-token write-command grants; cross-user vs cross-member provider-pin 400s merged.
- Run-create per-connector injection variants (cloudflare, base44, slock, meta-ads, tiktok-ads, lark-cached, github alias map, orphaned-secret filtering): the run-create arms are connector-agnostic, shapes live in `packages/connectors`; RUN-02 keeps one representative per arm. `agentRunQueue.encryptedParams`/`additionalVolumes`/`appendSystemPrompt` row asserts → claim-response reads; raw secret-value asserts → firewall-auth webhook resolution; "entitled vm0 without managed keys → 503" not deterministically constructible while alive legacy files seed global vm0 keys; `${{ vars.* }}` in custom-connector prefixes rejected by the contract.

- Agent-callback "failed → no summary" (statement-identical to the progress early return); schedule "verifies by callbackId with multiple callbacks" (every interpreter-fired schedule run carries reschedule plus chat callbacks and the dispatcher always sends callbackId); event-consumer/telegram-typing 401 variants merged into the WHCB-04 wrapper matrix; `zeroRuns.summary` row asserts replaced by OpenRouter summarize-request mock state.

- Org/member/Slack/push/auth-me cache row asserts → follow-up GET/list/status reads; per-route 401/no-org/sandbox duplicates merged into per-cluster matrices; "zero token without billing:read/maps:read" 403s not API-constructible (`generateZeroToken` grants them unconditionally); realtime publish-count asserts → read-after-write; compose stored-content/zero_agents row asserts → compose reads; cancel-side Ably/queue/callback-row asserts → queue reads and MSW deliveries; github-prs `bad_gateway` 502 never covered on main; `signPatJwtForTests` consumers deleted with the legacy files.

Schedule-execution chain notes: the execute-schedules cron response exposes only global executed/skipped counts and no run ids — run identity is asserted through the org run queue and schedule-thread user messages, and counts are never asserted strictly on a shared DB. Forward `mockNow` beyond 15 minutes makes real-created pending runs invisible to concurrency accounting (`PENDING_RUN_TTL_MS`); schedule-execution chains must keep mocked due times inside that window when run-queue state is asserted.

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

Legacy test files deleted after verifying replacement coverage by the listed check. Older rows used full-suite per-file coverage diffs; newer rows use targeted local BDD checks plus CI follow-up.

| Deleted legacy file                                                                                                                                        | BDD replacement                                                                                                                      | Verified by                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `health.test.ts`                                                                                                                                           | OPS-02 in `hooks-ops.bdd.test.ts`                                                                                                    | full-suite per-file diff vs baseline |
| `zero-feature-switches.test.ts`                                                                                                                            | OPS-01 in `hooks-ops.bdd.test.ts`                                                                                                    | same                                 |
| `zero-chat-threads-pin.test.ts`, `zero-chat-threads-unpin.test.ts`, `zero-chat-threads-rename.test.ts`                                                     | CHAT-01 mutation chain in `chat-files.bdd.test.ts`                                                                                   | same                                 |
| `zero-voice-io-quota.test.ts`                                                                                                                              | FILE-02 in `billing-usage-media.bdd.test.ts`                                                                                         | same                                 |
| `zero-me-model-providers-list.test.ts`                                                                                                                     | MISC-04 in `misc-routes.bdd.test.ts`                                                                                                 | same                                 |
| `desktop-auth.test.ts`                                                                                                                                     | AUTH-02 in `auth-device.bdd.test.ts`                                                                                                 | same                                 |
| `cron-telegram-cleanup.test.ts`                                                                                                                            | SCHED-02 safe-cron chain in `runs-schedules.bdd.test.ts`                                                                             | same                                 |
| `zero-integrations-telegram-upload-init.test.ts`                                                                                                           | INT-02 in `integrations.bdd.test.ts`                                                                                                 | same                                 |
| `email-unsubscribe.test.ts`                                                                                                                                | MISC-02 in `misc-routes.bdd.test.ts`                                                                                                 | same                                 |
| `zero-realtime-token.test.ts`                                                                                                                              | AUTH-02 realtime token in `auth-device.bdd.test.ts` plus run-lifecycle publishes                                                     | same                                 |
| `cron-reconcile-billing-entitlements.test.ts`                                                                                                              | BILL-01 reconciliation cron chains in `run-lifecycle.bdd.test.ts`                                                                    | same                                 |
| `cron-aggregate-usage.test.ts`                                                                                                                             | SCHED-02 safe-cron chain plus entitled usage reads in `run-lifecycle.bdd.test.ts`                                                    | same                                 |
| `zero-memory.test.ts`, `zero-onboarding-status.test.ts`                                                                                                    | CHAT-03 memory chain in `chat-files.bdd.test.ts`; ORG-03 status chain in `auth-org-agents.bdd.test.ts`                               | same                                 |
| `zero-connectors-oauth-device-auth.test.ts`, `zero-codex-device-auth.test.ts`, `zero-claude-code-device-auth.test.ts`                                      | CONN-02 device-auth chains A-G in `connectors.bdd.test.ts`; MODEL-PROVIDER chains H/I/K/L in `auth-device.bdd.test.ts`               | same                                 |
| `zero-slack-events.test.ts`, `zero-slack-commands.test.ts`, `zero-slack-interactive.test.ts`                                                               | INT-01 Slack app deep webhook flows (9 chains) in `integrations.bdd.test.ts`                                                         | same                                 |
| `cron-execute-schedules.test.ts`, `cron-drain-email-outbox.test.ts`                                                                                        | SCHED-02 cron execution and email outbox chains in `runs-schedules.bdd.test.ts`                                                      | same                                 |
| `zero-runs-cancel.test.ts`, `webhooks-agent-events.test.ts`, `zero-usage-members.test.ts`                                                                  | HOOK-01/RUN-03 callback-dispatch, HOOK-02/CHAT-02 optional-consumer, and BILL-02 usage-members chains in `run-lifecycle.bdd.test.ts` | same                                 |
| `zero-custom-connectors{,-create,-patch,-secret-set,-secret-delete,-delete}.test.ts`                                                                       | CONN-03 custom-connector chains A1-A4 in `connectors.bdd.test.ts`                                                                    | same                                 |
| `zero-connectors-external-code.test.ts`                                                                                                                    | CONN-02 external-code chains B1-B6 in `connectors-external-code.bdd.test.ts`                                                         | same                                 |
| `cron-process-usage-events.test.ts`                                                                                                                        | BILL-02 usage processing via `run-lifecycle.bdd.test.ts` and the SCHED-02 safe-cron chain                                            | same                                 |
| `zero-schedules.test.ts`, `zero-schedules-enable.test.ts`, `zero-schedules-disable.test.ts`, `zero-schedules-run.test.ts`, `zero-schedules-delete.test.ts` | SCHED-01 lifecycle/run-now/chat-link/capability chains in `runs-schedules.bdd.test.ts`                                               | targeted BDD + CI follow-up          |

| `internal-callbacks-chat.test.ts` | CHAT-02/HOOK-01 chains A-I in `chat-callbacks.bdd.test.ts` | same |
| `connectors-type-callback.test.ts`, `test-oauth-provider-get.test.ts` | CONN-02 callback chains CB-A..CB-G and provider chains P1-P4 in `connectors.bdd.test.ts` | same |
| `github-oauth.test.ts`, `integrations-github-{get,patch,delete,label-listeners}.test.ts`, `internal-callbacks-github-issues.test.ts` | INT-03/CONN-02/HOOK-01 chains G1-G6 in `github-integration.bdd.test.ts` | same |
| `automations.test.ts`, `webhook-automations.test.ts`, `webhooks-automation.test.ts` | AUTOMATIONS-02/03 and HOOK-02 chains in `automations.bdd.test.ts` plus AUTOMATIONS-01 in `runs-schedules.bdd.test.ts`; current surface is unified `automations-v2` | same |
| `internal-callbacks-slack-org.test.ts` | INT-01/HOOK-01 Slack org callback chains in `integrations.bdd.test.ts` | same |
| `zero-integrations-agentphone-link.test.ts`, `zero-integrations-agentphone-routes.test.ts` | INT-03 AgentPhone chains AP-A..AP-M1 in `agentphone.bdd.test.ts` | same |
| `audio-transcriptions-v1.test.ts`, `generate-image.test.ts` | FILE-02 MEDIA-A/MEDIA-B in `billing-usage-media.bdd.test.ts` | same |

| `zero-slack-{events,commands,interactive}.test.ts` (re-deleted after the #17031 agent-switch-filter delta was re-covered), `desktop-auth.test.ts` (re-deleted after the handoff-status delta), `cron-execute-schedules.test.ts`, `connectors-type-callback.test.ts` (re-deleted; deltas statement-neutral or covered) | INT-01 visibility chains in `integrations.bdd.test.ts`; AUTH-02 handoff chains in `auth-device.bdd.test.ts`; existing SCHED-02 and CB chains, now routed through `cron-execute-automations` | same |
| `automations.test.ts`, `cron-execute-schedules.test.ts`, `zero-schedules-run.test.ts`, `zero-logs-list.test.ts` (re-deleted after the #17334 automation trigger-source delta) | AUTOMATIONS/SCHED run-now and cron-visible dispatch chains in `automations.bdd.test.ts`/`runs-schedules.bdd.test.ts`; `schedule`/`automation` log filter compatibility in `run-reads.bdd.test.ts`; current cron route is `cron-execute-automations` | same |
| `zero-chat-threads.test.ts` (re-deleted after the #17323 soft-state removal), `zero-chat-messages.test.ts`/`zero-slack-events.test.ts` (re-deleted after the #17338 vm0-key test-only delta) | CHAT-01/02/03 detail and message chains in `chat-threads.bdd.test.ts`, `chat-files.bdd.test.ts`, and `chat-messages.bdd.test.ts`; vm0-managed-key behavior asserted through runner claim/firewall-auth production read surfaces in `run-lifecycle.bdd.test.ts`/`integrations.bdd.test.ts` | same |
| `zero-computer-use.test.ts` | FILE-03 chains T1-T7 in `computer-use.bdd.test.ts` | same |
| `zero-host.test.ts`, `zero-maps.test.ts` | FILE-01 HOST-A..E and BILL-02 MAPS-A plus the HOST-B/MAPS-B run-scoped zero-token chain in `host-maps.bdd.test.ts` | same |
| `webhooks-third-party.test.ts` | WHCB-07A..H Stripe and WHCB-08A/B Clerk teardown chains in `webhooks-callbacks.bdd.test.ts`; G7-G9 in `github-integration.bdd.test.ts`; RUN-03 runner chains in `run-lifecycle.bdd.test.ts` | same |
| `runners.test.ts` | RUN-03 chains in `run-lifecycle.bdd.test.ts`; DB-seeded claimedAt/poison arms are listed as unreachable API candidates below | targeted RUN-03 + docs exception |

| `storages-write.test.ts`, `storages.test.ts` | FILE-01 STOR-01..04 in `storages.bdd.test.ts`; write-side 413/mismatch/dedup statements now owned by WHCB-09 in `webhooks-callbacks.bdd.test.ts`; ambiguous-prefix arm listed as unreachable API candidate below | targeted STOR-01..04 + docs exception |
| `cli-auth.test.ts` | AUTH-02 CLI-A..E and CLI-TEST-A..F chains in `cli-auth.bdd.test.ts` | same |
| `logs-search.test.ts`, `model-stats.test.ts`, `user-export.test.ts` | OPS-01/RUN-04 LS, BILL-02 MS (sole owner of the aggregate-model-stats cron), and OPS-01 UE chains in `ops-logs.bdd.test.ts` | same |
| `zero-chat-messages.test.ts` | CHAT-02/RUN-01/CHAIN-CHAT/FILE-03 chains CM-A..P in `chat-messages.bdd.test.ts` | same |
| `zero-runs-create.test.ts` (remaining vm0-managed-key, agent-provider-pin, custom-skill-volume, and nested trigger-agent DB-seeded arms deleted and listed below) | RUN-01/02 chains in `run-lifecycle.bdd.test.ts` | targeted RUN-01/02 + docs exception |

| `internal-callbacks-agent.test.ts`, `internal-event-consumers.test.ts`, `internal-event-consumers-telegram-typing.test.ts`; `internal-callbacks-trigger.test.ts` remains alive | HOOK-01 replayed-delivery agent and SCHED-CB reschedule chains, CHAT-02 codex/thread-less extensions, WHCB-04 axiom consumer cases, and the INT-02 typing chain across `run-lifecycle.bdd.test.ts`, `runs-schedules.bdd.test.ts`, `webhooks-callbacks.bdd.test.ts`, `integrations.bdd.test.ts` | same |

| `zero-chat-threads{,-create,-list,-delete,-patch,-mark-read,-messages,-model-selection}.test.ts`, `zero-chat-search.test.ts`, `zero-chat-threads-github-prs.test.ts`, `zero-chat-threads-artifacts.test.ts`, `zero-chat-threads-artifacts-sync.test.ts`, `chat-threads-v1.test.ts` | CHAT-01/03 chains in `chat-threads.bdd.test.ts`, the CHAT-01 mutation chain in `chat-files.bdd.test.ts`, and the CHAT-02 queued-attachment case in `chat-messages.bdd.test.ts`; legacy artifact-row sync arms listed below | targeted CHAT-03 + docs exception |
| 9 compose legacy files (`agent-composes-*`, `zero-composes-*`) | COMPOSE-01 chains in `composes.bdd.test.ts` plus the lifecycle chain in `auth-org-agents.bdd.test.ts` | same |
| 10 org/team legacy files (`zero-org*`, `zero-team`, `zero-default-agent`, `zero-onboarding-setup`) | ORG-01/02/03, TEAM-01, AGENT-02 chains ORG-LOGO-A..ORG-TOKEN-G in `org-team.bdd.test.ts` | same |
| 13 user-config legacy files (`zero-secrets*`, `zero-variables*`, `zero-api-keys*`, `zero-user-*`, `zero-push-subscriptions`, `auth-me`, `health-auth-probe`) | AUTH-01/03 batches UC-A..D in `user-config.bdd.test.ts` | same |
| 14 run-read legacy files plus the deleted DB-seeded `agent-runs-create.test.ts` and `agent-run-telemetry.test.ts` remnants | RUN-03/04 read chains and RUN-01/02 resume/admission chains in `run-reads.bdd.test.ts` | targeted RUN-03/04 + docs exception |
| `webhooks-agent-checkpoints.test.ts`, `webhooks-agent-storage.test.ts`, `webhooks-agent-health-usage-telemetry.test.ts`, `webhooks-agent-firewall-auth.test.ts`, `webhooks-agent-complete.test.ts` | CHAIN-RUN/RUN-03 chains in `run-lifecycle.bdd.test.ts`, WHCB-05/06/09 in `webhooks-callbacks.bdd.test.ts`, FW-2/3/4/8/9/10 in `webhooks-agent-firewall-auth.bdd.test.ts`; firewall and priced-usage inconsistent-state arms listed below | targeted webhook BDD + docs exception |

All candidates from the earlier kept-alive list (deletion previously regressed collateral services) now have BDD replacements and are deleted above. `helpers/zero-slack-webhooks.ts` stays alive: `test-slack-dispatch-probe.test.ts` still imports it.

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
- `zero-memory-detail.service.ts:91-94` (`!version || !bucket` → `return base`): needs `storages.head_version_id` pointing at a missing `storage_versions` row (FK forbids) or an unset `R2_USER_STORAGES_BUCKET_NAME` (always stubbed); already uncovered at the main baseline (21/22), so no parity impact.
- `runners.ts` claim-conflict 409 branches: `claimedAt` is never written (successful claims delete the queue row), so the conflicting state cannot exist; the main baseline covered `runners.ts:340` only by directly updating `runner_job_queue.claimed_at` in the legacy `runners.test.ts`.
- `runners.ts` poison-job handling for malformed execution contexts: contexts are always produced schema-valid by the dispatch payload builders. Baseline coverage of `warnInvalidStoredExecutionContext` validation issue logging (62-85), `failPoisonQueuedJob` (506-552), `scheduleClaimFailedSideEffects$` (689-726), and the claim-side poison arms (757-785) came exclusively from DB-seeded execution contexts; the legacy `runners.test.ts` remnant was deleted with those cases recorded here (firewall-auth precedent).
- `connector-oauth-device-auth.service.ts` `resolveStoredDeviceAuthMethod` invalid-stored-method 500 (lines 255-264): sessions are only created after `resolveDeviceAuthMethod` validates the method, so a stored session with a non-device-auth method can exist only across a deploy that removes the method from the connector definition. Not constructible through any API.
- `connector-oauth-device-auth.service.ts` `parseEncryptedProviderState` corrupt/mismatched-state failure (lines 453-471): provider state is always written schema-valid with the session's own connector type by the same service; corruption requires direct DB writes.
- `zero-connector-data.service.ts` `validateExtraConnectorTokenSecrets` mapped-output / unsupported-name throws (lines ~1474-1488) and the required-extra-secret throw in `validateConnectorTokenOutputRequirements`: extra connector secret names are constructed statically by in-repo providers (e.g. slock's `SLOCK_SERVER_ID`); a violation requires a provider-code bug, not any request input. Legacy reached these only by monkey-patching provider modules.
- `connector-external-code.service.ts` `resolveStoredExternalCodeMethod` 500 branch and `parseEncryptedProviderState` connector/method mismatch throw: require a stored session row whose authMethod or encrypted provider state disagrees with what `startConnectorExternalCodeSession$` wrote; every public write path produces them consistently and atomically.

- `internal-callbacks-chat.ts:1545-1551` (payload schema parse failure, 400 "Invalid or missing payload"): the only writers of chat-callback rows persist schema-valid `{threadId, agentId}` payloads, and the dispatcher echoes the stored payload inside the HMAC-signed body, so a malformed payload requires a direct DB write or a forged signature.
- `internal-callbacks-chat.ts:1532-1536` (payload/DB thread-mapping mismatch warn): `zero_runs.chatThreadId` is written once at run creation with the same threadId stored in the callback payload and only ever transitions to NULL (thread-delete FK `set null`), which returns through the missing-thread branch instead.
- `connectors-type-callback.ts` `validateStoredAuthCodeMethod` failure arms and callers (lines 273, 295, 306, 318, 445, 547): `connector_oauth_states.authMethod` is written only after validating an auth-code grant method for the same connector type, and `claimConnectorOAuthState` filters rows by connector type — a stored state whose method is missing, non-auth-code, or unparseable can exist only across a deploy that removes or re-kinds the method.
- `zero-connector-data.service.ts` missing-required-token-output throw (~1419) and unsupported-output-name throw (~1433): provider exchange results are zod-parsed before outputs are constructed, so a violation requires a provider-code bug; legacy reached these only by monkey-patching provider modules.
- `internal-callbacks-slack-org.ts:587` (400 "Invalid or missing payload"): the only producer of callbacks targeting this URL writes the payload schema-valid, and the per-callback HMAC secret is generated server-side and never exposed.
- `internal-callbacks-slack-org.ts:228-229` (`resolveOrgDefaultModelProviderSelectedModel` find-predicate body): the query filters `model_providers` on `is_default = true`, and no production write path sets `model_providers.is_default = true`.
- `zero-github-footer.service.ts` `resolveOrgDefaultModelProviderSelectedModel` (query, find predicate, and fallback arms): same argument as the Slack variant above — the query filters `model_providers` on `is_default = true`, and no production write path sets that column. Reachable only through historical data; the surrounding footer rendering is covered by the GitHub completed-delivery chain.
- `internal-callbacks-github-issues.ts:417-421` (pending-installation 400): requires a `github_installations` row with NULL `installationId`; every production write path inserts `status: "active"` with the remote id, and nothing nulls the column.
- Legacy webhook-automation insert-returning throws and route-side parse failures (contract-valid body cannot fail the route-side parse); the current management surface is the unified `automations-v2` trigger API.
- `webhooks-automation.service.ts` rate_limited arm (~152-155) and `routes/webhooks-automation.ts:53`: requires 11 billable runs within 60 seconds; baseline-uncovered too.
- `run-uploaded-files.service.ts:48` (`isRunUploadedFileSource` falsy-source arm in `sourceForRun`): requires a runId whose `agent_runs` row exists without its `zero_runs` row, but the only production insert creates both in one transaction with a NOT NULL `trigger_source`; every enum value is truthy. The legacy agentphone test reached it only by DB-seeding an `agent_runs` row alone. The `.some → false` fallback arm stays covered through the `"webhook"` trigger source.
- `audio-transcriptions-v1.ts` free-quota 402 (lines 95, 256-257): requires `org_metadata.tier = 'free'`, but no public write path produces that tier — onboarding defaults to `pro-suspend`, Stripe webhooks and downgrade routes only write `pro`/`team`/`pro-suspend`. The daily-rate and daily-duration gates are covered through the API.

- `desktop-auth.service.ts:90-92` (`createDesktopAuthHandoffCode` insert-returning-empty throw) and `routes/desktop-auth.ts:117` (rethrow of non-handoff consume errors): defensive arms requiring a mid-request DB failure; uncovered on main's own suite as well.
- `zero-computer-use.ts:476-482` (approval success mapping), `zero-computer-use.service.ts:1155-1221` (deny/approvePendingComputerUseWriteCommand), and the `requiresApproval` created-audit insert (service 1032-1038): both command-create routes hardcode `requiresApproval: false`, so `pending_approval` is not API-constructible; the decide route's disabled/not_found/not_pending arms are covered by FILE-03. The service's defensive `.returning()`-empty throws and the post-filter missing-host throw are the same class as the webhook-automations entries.
- `zero-host.service.ts:230-235` (`jsonObjectText` brace extraction): only runs when model output parses to literal JSON `null` (`safeJsonParse` returns `undefined` on failure, short-circuiting the guard); uncovered at baseline too.

- `zero-voice-io-post.service.ts:348` (`return null` when `bytesPerSecond` is non-finite or <= 0): `hasUsableWavFormat` already guarantees positive bounded channels/sampleRate/bitsPerSample from `getUint16`/`getUint32` reads, so the product is always a finite positive number. Defensive guard, not exercisable via crafted bytes.

- `routes/cli-auth.ts:126-136` (token-exchange `access_denied` arm and its row delete): no production write path sets `device_codes.status = 'denied'` — the browser approve route and the test-approve route write only `authenticated`, and the web cli-auth page has no deny action; the enum value is historical. The main baseline covered these statements only through direct row seeding.
- `zero-chat-messages.ts:1196-1197`, `:2481` (stored-thread-pin resolution failures) and `zero-model-selection.service.ts:180` (sentinel pin naming an unsupported model): thread pins are persisted model-only after the same request validated the model, and the contract superRefine rejects unsupported sentinel selections at parse time — only reachable across a model-removal deploy or direct DB writes.

- `agent-composes-read.service.ts` no-head 400 arm and instructions safeParse-failure arm: every public write path sets `head_version_id` and contract-validates content in the same request; baseline reached both via DB-seeded rows.
- `zero-chat-thread.service.ts:405-434` (`resolveAttachFileUrls` incl. `inferMimetype`) and `:460`: every API writer of `chat_messages.attachFiles` persists `attachFileMetadata` in the same insert and the queued auto-send resolver prefers metadata; only pre-migration rows reach the S3-listing resolution. `zero-chat-messages.ts:564-566` (prior-run `User:` unshift): every thread-linked run writer persists a content-bearing user message in the same transaction.
- `agent-run-storage.service.ts:409, 507-510, 654-655` (missing additional-volume storage at dispatch): `zero_agents.customSkills` referencing a skill whose storage row is absent is not API-constructible — skill create uploads the volume server-side and skill delete clears agent references atomically.
- `zero-run-queue.service.ts:304-308` and `agent-run-queue-payload.service.ts:46` (NULL `encrypted_params` promotion): every production enqueue encrypts params at insert. `agent-run-create.service.ts:2646-2647` (legacy-TEXT conversation history): the checkpoint webhook persists hash-only history and `conversations.cli_agent_session_history` has no production writer. `agent-run-telemetry.service.ts:94` and `zero-run-detail.service.ts:34` (`content.agent.framework` legacy compose form): the compose content schema strips unknown keys.
- `zero-compose-data.service.ts:44` `content ?? null` null arm: needs a head pointer without its version row.
- `agent-run-create.service.ts` vm0-managed provider-key selection/fallback/minimax routing, the post-resolution vm0 credit gate, and vm0 billable context need rows in `vm0_api_keys` plus org-default `model_providers.is_default = true`; neither has a public write API. `zeroAgents.modelProviderId` provider pins likewise have no public writer, and chat/schedule entry points resolve provider types before dispatch. The legacy `zero-runs-create.test.ts` remnant reached these only by DB seeding and was deleted with the arms recorded here.
- `agent-run-create.service.ts` custom-skill seed-volume override requires direct writes to `zero_agents.customSkills`; public skill create/delete paths create the storage volume or clear references atomically. The normal custom-skill volume surface remains covered through run-create/lifecycle BDD.
- `agent-run-create.service.ts` nested trigger-agent metadata/callback arms need a zero-token with `agent-run:write` and a DB-seeded parent run; production zero tokens exclude that capability, and API-created parent runs cannot mint it. The `createZeroIntegrationRun$` trigger path remains owned by `test-telegram-dispatch-probe.test.ts`.
- `agent-run-create.service.ts` stored-connector 500 arms (incomplete connector-owned state and invalid stored auth method) need partial `connectors`/`secrets`/`variables` rows that public connect flows write atomically after validating the auth method.
- `agent-run-telemetry.service.ts` Postgres `sandbox_telemetry` aggregation needs historical rows in `sandbox_telemetry`; the current telemetry webhook writes to Axiom datasets and has no apps/api writer for that table. Route-level telemetry success/error behavior stays covered by RUN-04 in `run-reads.bdd.test.ts`.

Production-reachable but not API-constructible (recorded as explicit exceptions; these are concurrency races or historical states, not dead code):

- `agent-webhook-firewall-auth.service.ts` advisory-lock branches (locked refresh divergence, mid-request row deletion, `source-missing` statuses): the legacy test reached them with pg advisory locks held across requests. `webhooks-agent-firewall-auth.bdd.test.ts` covers the API-reachable surface (the file now exceeds its baseline), and the legacy remnant was deleted with these non-API-constructible arms recorded here: advisory-lock concurrency cases, missing-row/stale-secret inconsistent-state cases, credit-state-missing, null-expiry forced refresh, and omitted-runtime-output validation.
- `storage-read.service.ts:182-184` (ambiguous-prefix 400) and the `versionErrorResponse` badRequest arm (208): version ids are SHA-256 content hashes computed server-side; two versions of one storage sharing an 8-hex prefix cannot be constructed deterministically through any API (birthday bound ~2^16 commits). Production-reachable with long version histories, so the legacy `storages.test.ts` remnant was deleted with this arm recorded here (runners.test.ts precedent).
- `agent-run-callback.service.ts:64` (`dispatchRunCallbacks` missing-run `return []`): only reachable when the `agent_runs` row disappears between the terminal-transition commit and the detached dispatch (org deletion racing a cancel). Uncovered in the main baseline as well, so not a parity gap.
- `zero-slack-webhooks.service.ts` `resolveEffectiveCompose` `not_found` arm (646-647) and its DM/ephemeral notice case (1414-1425): requires `orgMetadata.defaultAgentId` to reference a compose with no `zeroAgents` row; the column's FK is `onDelete: 'set null'` and the default-agent PUT validates `zeroAgents` membership, so every public write/delete path keeps the reference valid. Reachable only through historical data; the legacy test seeded an orphan compose directly. BDD covers the adjacent `not_configured` notice on both ephemeral and DM branches, and covers the `not_accessible` arm through the admin-sets-private-default API journey.
- `onboarding.service.ts:500-501` (`defaultAgentInfo` `!row → return null`): same FK argument as above — `org_metadata.default_agent_id` is `onDelete: 'set null'` and only validated zero-agents can be set as default, so an orphan reference is not API-constructible; the legacy test seeded it directly. The ORG-03 chain covers the adjacent deleted-default path (`defaultAgentId` null).
- `zero-chat-thread.service.ts` / `google-drive-artifact-sync.service.ts` legacy artifact URL resolution fallbacks (`run_uploaded_files` rows without `metadata.s3Key`, persisted CDN URLs without metadata keys, and legacy `/f/{userId}/{id}/{filename}` storage-bucket URLs) require historical rows or direct DB writes. Current artifact writers persist artifact-bucket keys through metadata, and CHAT-03 in `chat-threads.bdd.test.ts` covers API-reachable upload grouping, hosted-site filtering, Google Drive connection status, disconnected/not_synced/synced/unknown statuses, 401/400/404 request boundaries, and run-scoped sandbox uploads. The legacy `zero-chat-threads-artifacts-sync.test.ts` remnant also asserted Google Drive multipart body shape and hosted zip internals; those are provider implementation details rather than API-visible Then assertions.

## Open Helper Gaps

These gaps must be closed before the corresponding old tests can be safely deleted:

- ~~Billing and credit fixture setup that is visible through billing status.~~ Closed: `grantProEntitlement` in `helpers/api-bdd-runs-schedules.ts` moves an onboarded org to the pro tier with credits through the public Stripe `invoice.paid` webhook and verifies via billing status.
- ~~vm0-managed-provider runs (`vm0_api_keys` has no public write API), the post-resolution vm0 gate, the vm0 billable arm, the nested trigger-agent family (zero tokens exclude `agent-run:write`), the custom-skill seed-volume override, and the agent provider pin (`zeroAgents.modelProviderId` has no public writer).~~ Removed from executable legacy coverage and recorded under Unreachable Code Candidates; `createZeroIntegrationRun$` coverage is owned by the alive `test-telegram-dispatch-probe.test.ts`.
- `usage_pricing` has no write API: the priced settlement path (zero-credit-usage charge/expire/deduct plus the auto-recharge trigger) and the tier-less drain arm (org without `org_metadata`) were deleted with the legacy `webhooks-agent-complete.test.ts` remnant and recorded here.
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
