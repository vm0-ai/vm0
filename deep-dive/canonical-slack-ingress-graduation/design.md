# Design: Graduate canonical Slack ingress and remove the legacy fork

## Goal

Make canonical Slack-to-chat ingress the only execution model for connected
users, graduate the related Web visibility and asset behavior, and remove the
legacy Slack run, callback, session, and test paths.

## Final product semantics

- `canonicalSlackIngress`, `canonicalSlackWebVisibility`, and
  `canonicalSlackAssets` are fully removed. There is no user, org, or emergency
  opt-out and no legacy execution fallback.
- A historical Slack thread starts a new canonical chat thread on its first
  eligible post-cutover message.
- Historical Slack messages are not copied into `chat_messages`.
- The legacy VM0 agent session is not attached to the new canonical thread.
  Slack-visible conversation context remains available through Slack context
  enrichment.
- Canonical Slack threads are visible in Web Chat by default.
- Canonical assets are the only Slack asset representation.
- Existing canonical messages created before asset graduation retain their
  attachments through a bounded materialization pass; legacy Slack messages
  are not backfilled.
- `/zero switch` and `/zero model` affect only Slack threads created after the
  preference change. Existing canonical threads retain their bound agent and
  model.
- Missing account connections, missing default agents, missing agents, and
  inaccessible agents retain their current user-facing notices. These are
  canonical admission preconditions and never invoke a legacy run.
- Canonical Slack reply delivery keeps its current single-attempt semantics.
  Delivery failures are monitored rather than automatically retried.
- Existing normal run and callback history is retained. Legacy route and
  session rows are migration state and can be deleted.
- After final schema contraction, recovery is roll-forward only; rollback to a
  version that requires the legacy Slack schema is unsupported.

## Release boundary 1: canonical cutover

### Admission and historical routes

- New eligible Slack events unconditionally use canonical ingress.
- An existing legacy route is promoted to a canonical route on the first new,
  non-retry Slack event for that route key.
- Promotion creates an empty canonical `chat_thread`, binds it to the existing
  physical Slack route, and does not create historical messages.
- A Slack retry against a still-legacy route is acknowledged without
  promotion. This preserves the old retry behavior during mixed-version
  deployment and prevents an originally legacy event from being executed again
  as canonical.
- Promotion persists both the cutover event ID and its sortable Slack message
  timestamp. Current readers reject pre-cutover retries before admission while
  still admitting later canonical retries whose first insert failed.
- A migration-installed ingress classifier is the receiver-first compatibility
  boundary for draining API revisions. If an older reader admits a delayed
  pre-cutover event after promotion, the database records it as `ignored`;
  canonical processing cannot claim or execute that record.
- Existing canonical routes remain unchanged.
- Dormant legacy routes do not create empty Web Chat threads merely because the
  release was deployed.

### Feature graduation

- Canonical Web visibility becomes unconditional.
- Canonical asset ingestion and publication become unconditional.
- Existing canonical messages with pre-graduation Slack attachment state are
  materialized into canonical assets through a bounded compatibility path.
- The three feature-switch definitions and stored override keys cease to
  control runtime behavior.

### Compatibility retained during the observation window

- `slack:org` callback dispatch remains readable for runs created before or
  during deployment overlap.
- `slack_org_thread_sessions` remains available for those old callbacks and
  unexpired legacy Computer Use authorization requests.
- The legacy direct-run implementation is not selected for any new,
  non-retry event after route promotion is active.
- Existing deployments already understand canonical route rows. The
  migration-installed ingress classifier additionally makes their unconditional
  canonical admission safe after a route has been promoted.

### User-facing commands and notices

- `/zero switch` and `/zero model` keep updating user preferences.
- Their confirmation copy states that the selection applies to new Slack
  threads.
- Connection and agent-configuration notices are preserved independently of
  the removed legacy executor.

## Cutover gate

Final contraction becomes eligible after:

- four continuous hours at full canonical enrollment;
- at least 20 completed end-to-end canonical Slack deliveries;
- zero stuck canonical ingress rows;
- zero stuck `slack:chat` callbacks;
- zero queued-message orphans;
- zero `slack_chat_delivery` failures in the gate window;
- successful Slack retry deduplication evidence;
- no new `slack:org` callbacks after old API instances, old runs, and the
  one-hour Computer Use authorization TTL have drained.

If four hours elapse before 20 deliveries, the gate remains open only until the
delivery sample reaches 20.

## Release boundary 2: irreversible contraction

- Remove the legacy direct Slack run construction and dispatch path.
- Remove the `slack:org` callback handler and its progress and terminal
  dispatch cases after confirming no actionable rows remain.
- Remove legacy Slack Computer Use scope reconstruction and session-backed host
  binding.
- Delete `slack_org_thread_sessions` and its indexes and foreign-key consumers.
- Delete all remaining dormant legacy route rows.
- Contract `slack_chat_thread_routes` to canonical-only state and remove the
  legacy backend discriminator if it no longer carries information.
- Remove the three canonical Slack feature-switch keys and stored override
  values.
- Remove the historical canonical-asset compatibility path after its bounded
  population reaches zero.
- Replace the legacy `/api/test/slack-dispatch-probe` contract and E2E helper
  with canonical webhook-to-queue coverage.
- Remove legacy-only BDD scenarios while retaining canonical coverage for
  retries, notices, queueing, assets, Web visibility, Computer Use, commands,
  delivery, failure, and cancellation.

## Required production evidence

- Counts of legacy and canonical route rows before and after cutover.
- Counts and oldest age for pending, failed, and processing canonical ingress.
- Counts and oldest age for pending and failed `slack:chat` callbacks.
- Count of newly created `slack:org` callbacks during and after drain.
- Count of unexpired legacy Slack Computer Use authorization requests.
- Count of canonical messages still requiring asset materialization.
- Queue orphan count.
- End-to-end canonical delivery count and failure count.
- Retry admission and deduplication outcomes.

## Out of scope

- Copying historical Slack messages into Web Chat.
- Preserving legacy VM0 agent-session continuity.
- Adding automatic retries for canonical Slack delivery.
- Retaining a legacy fallback or runtime opt-out.
- Changing Teams integration behavior.
