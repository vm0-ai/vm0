# API-first BDD migration plan (`turbo/apps/api`)

Authoritative plan for rewriting the `turbo/apps/api` Vitest suite into
**API-first BDD** tests without losing coverage relative to `main`. Tracks the
work for [#16967](https://github.com/vm0-ai/vm0/issues/16967). Keep this file
updated every round — it is the spec, not a report.

## Goal (recap)

Every route test is rebuilt as: **setup app → Given via real API requests →
When via one real API request → Then via real API requests**. No direct DB
seeding, no DB row assertions. Tests that share one expensive Given are merged
into a single `it()` with a chain of When→Then steps (GWT-WT-WT). Coverage must
never be silently lost: any per-file gap is recorded here as a service-level
exception, an Open Helper Gap, an Unreachable Code Candidate, or an approved
drop decision.

## Coverage baseline (`main`)

Captured with `pnpm -F api exec vitest run --coverage` on `main`
(`/tmp/vm0-api-coverage/baseline-main/coverage-summary.json`):

| metric     | baseline |
| ---------- | -------- |
| statements | 87.21%   |
| branches   | 72.83%   |
| functions  | 93.37%   |
| lines      | 87.21%   |

Per-file baselines for the source files touched this round (covered / total):

| source file                             | statements | branches  | functions |
| --------------------------------------- | ---------- | --------- | --------- |
| `routes/zero-agents.ts`                 | 253 / 266  | 132 / 159 | 37 / 37   |
| `routes/zero-default-agent.ts`          | 16 / 17    | 7 / 8     | 1 / 1     |
| `services/zero-agent-data.service.ts`   | 24 / 26    | 5 / 7     | 17 / 19   |
| `services/agent-compose.service.ts`     | 56 / 58    | 11 / 14   | 10 / 10   |
| `services/zero-compose-data.service.ts` | 85 / 87    | 53 / 54   | 19 / 20   |
| `lib/require-agent-permission.ts`       | 6 / 9      | 8 / 10    | 1 / 2     |

## Test principles

1. **Setup app at module scope, clients per test.** `const context =
testContext()` at module scope; build ts-rest clients with
   `createBddApi(context)` _inside_ each `it()` (the app fetcher captures the
   abort signal at construction time, which `testContext()` rotates per test).
2. **Given via real API requests.** Build every precondition (agents, skills,
   connectors, …) by sending real HTTP requests. `store.set(writeDb$)` and
   Drizzle inserts are forbidden in BDD tests.
3. **When is one real API request.** The action under test is a single HTTP
   call through the app.
4. **Then via real API requests.** Assert on the When response, then verify
   state through follow-up GET/list/status routes or external-provider mock
   state. No DB row assertions.
5. **Mock only external services** via `context.mocks` (Clerk, S3, …). Never
   `vi.mock("../…")`, never `vi.stubGlobal("fetch", …)`, never
   `vi.useFakeTimers()` (use `mockNow` if deterministic time is needed).
6. **ccstate hygiene.** No floating promises; never silence with `void`/empty
   `.catch`. Cleanup ordering in `setup.ts` is already wired — do not reorder.

## Helper contract

BDD helpers are **thin wrappers over route calls** — never DB writers/readers.

- `createBddApi(context)` (`routes/__tests__/helpers/api-bdd.ts`) returns ts-rest
  clients (`agents`, `agentsById`, `skills`) plus mock-only setup:
  - `actAsAdmin({ userId?, orgId? })` / `actAsMember({ userId, orgId })` /
    `actAsNoOrg(userId?)` — mock a Clerk session and return the acting identity.
    Clerk is an external service, so mocking the session is allowed; no DB
    membership/onboarding row is required (auth derives org + role from the
    session token alone).
  - `zeroAuth(capabilities)` — `Authorization` header for a sandbox "zero" token
    carrying the given capabilities, to drive capability-gated 403 branches.
  - `allowInstructionsStorage()` — stub S3 so the instructions-storage upload
    during agent creation succeeds (the only external dependency on that path).
  - `SESSION_AUTH` — the `Authorization` header for the active Clerk session.

## Case groups

Top-level families in `routes/__tests__` (≈230 legacy route test files). Each
family migrates to one `*.bdd.test.ts` (or a small set) following the chains
below. This file is filled in family-by-family as work proceeds.

- **AGENT** — agents CRUD + visibility/permissions + skills/connectors
  (`zero-agents*`, `zero-default-agent`, `zero-agent-custom-connectors`).
  _In progress (this round): agent CRUD lifecycle._
- RUN — `zero-runs*`, `agent-runs*`, `zero-run-*`, queue/admission.
- CHAT — `zero-chat-threads*`, `zero-chat-*`.
- CONNECTOR — `zero-connectors*`, `zero-custom-connectors*`, `zero-user-connectors`.
- BILLING/MEDIA — `zero-billing-*`, `zero-usage*`, `generate-image`, `*-io-*`.
- FILE/STORAGE — `storages*`, `legacy-file`, `zero-uploads-*`, `zero-web-download`.
- SCHEDULE — `zero-schedules*`, `cron-*`.
- INTEGRATION — `zero-integrations-*`, `zero-slack-*`, `*-telegram-*`, `github-*`.
- WEBHOOK — `webhooks-*`, `internal-callbacks-*`, `internal-event-consumers-*`.
- ORG/USER — `zero-org*`, `zero-team`, `zero-user-*`, `auth-me`, `cli-auth`.
- OPS — `health*`, `instrument`, `vercel-crons`, `release-please-config`,
  `app-factory`, `web-api-compatibility`, `model-stats`, `logs-*`.

## Migration state

**Families fully (or near-fully, modulo a documented gap) converted to API-first
BDD:** AGENT lifecycle + connectors, VARIABLE, SECRET, USER-PREFERENCES,
FEATURE-SWITCH, API-KEY, PERSONAL-MODEL-PROVIDER, COMPOSE read/list/by-name/
metadata, CUSTOM-CONNECTOR list/CRUD/secrets, CHAT-THREAD metadata/create/patch/
list, ORG (list/invite/membership-requests/logo/team/delete/get/update/leave/
members — complete), USER-MODEL-PREFERENCE, ATTRIBUTION, AUTH-ME, REALTIME-TOKEN,
DESKTOP-UPDATES, HEALTH.

**Gap families reduced** (Rounds 33–44): for each, the API-reachable subset —
the auth / capability / role / body-validation / admission / not-found
rejections that fire _before_ the gap-blocked work — is now converted to an
API-first `*.bdd.test.ts`, and the legacy is reduced to the seeded/external
cases (kept with a documented `GAP-*`). Coverage parity verified each round
(several reduces improved coverage; the coverage gate caught and corrected an
over-reach in the auto-recharge reduce). Done: RUN (create rejections; read/
cancel/queue rejections — `GAP-RUN-CREDITS`); BILLING **complete** (redeem-code
full, plus portal / invoices / checkout / downgrade / restore / auto-recharge
reductions — `GAP-STRIPE-CUSTOMER/SUBSCRIPTION`, `GAP-ORG-TIER`); SCHEDULE
(enable/disable/delete rejections — `GAP-SCHEDULE-DEPLOY`); ORG **complete**
(delete + get/update/leave + members rejections — `GAP-ORG-DELETE-CASCADE`,
`GAP-ORG-STATE`, `GAP-CLERK-MEMBERSHIP`); INTEGRATION (github installation read
rejections — `GAP-GITHUB-INSTALL`).

Two categories make up the remainder:

1. **Already API-first raw-route tests** — tests for raw Hono routes that have no
   ts-rest contract (so there is no `createBddApi` client to use). They already
   issue real HTTP requests through `createApp(...).request(...)` and mock only
   external concerns (env, time, S3, MSW), i.e. they already satisfy the
   principles. Examples: `legacy-file.test.ts`,
   `test-oauth-provider-get.test.ts`. No rewrite is required; renaming to
   `.bdd.test.ts` would be cosmetic.

2. **Remaining gap families to reduce** — CHAT messages, the rest of INTEGRATION
   (slack/telegram, github link/patch/delete), WEBHOOK, MEDIA (`*-io-*`,
   generate-image), STORAGE (`storages*`, uploads), connectors (oauth/device/
   manual), USAGE, LOGS, CRON, ONBOARDING, device-auth. Each follows the same
   reduce-legacy recipe as Rounds 33–44: convert the pre-gap rejection subset,
   keep documented gap-legacy for the seeded/external cases (in-flight runs,
   seeded chat messages, OAuth-connected connectors, S3 objects, signed
   webhooks). The reachable subset per file is typically small (2–6 cases), so
   these are incremental.

## Chained scenario candidates

- **CHAIN-AGENT** ✅ (this round) — create → GET → list → PATCH metadata →
  PUT full update → GET → DELETE → GET 404 / list excludes.
- **CHAIN-AGENT-LIMIT** ✅ — create 7 public → 8th 409 → private exempt →
  promote private→public 409 → delete frees a slot → create 201.
- **CHAIN-AGENT-VISIBILITY** ✅ — owner creates private → non-owner GET 404 /
  list excludes → owner GET 200.
- CHAIN-RUN — create run → poll status → cancel → status reflects cancel.
- CHAIN-CHAT — create thread → post message → list → rename → pin → delete.
- **CHAIN-CONNECTOR** ✅ — create custom connector → enable on agent → GET
  reflects → replace → clear → GET empty.
- **CHAIN-USER-CONNECTOR** ✅ — create agent → enable built-in types → GET
  reflects → replace → dedupe → clear → GET empty.
- **CHAIN-VARIABLE** ✅ — set variable → list → update (no dup) → list sorted →
  delete → list excludes → delete again 404.
- **CHAIN-SECRET** ✅ — set secret → list metadata → update → list sorted →
  delete → list excludes → delete again 404.
- **CHAIN-USER-PREFERENCES** ✅ — GET defaults → set all fields → GET → partial
  updates (timezone / pins / sendMode / capture) each preserve the rest.
- **CHAIN-FEATURE-SWITCH** ✅ — GET empty → set → merge → override → GET → clear
  (DELETE) → GET empty.
- **CHAIN-API-KEY** ✅ — create PAT (token once) → list (prefix only) → create
  2nd → list newest-first → delete → list excludes → delete again 404.
- **CHAIN-PERSONAL-MODEL-PROVIDER** ✅ (delete) — upsert provider → list →
  delete → list excludes → delete again 404.
- **CHAIN-COMPOSE-READ** ✅ — create agent → read its compose by id → 404 for
  unknown / malformed / cross-org.
- **CHAIN-COMPOSE-LIST** ✅ — create agents → list composes → delete one →
  list excludes → GET 404.
- **CHAIN-COMPOSE-BY-NAME** ✅ — create agent → read its compose by name → 404
  for unknown / cross-org.
- **CHAIN-COMPOSE-METADATA** ✅ — create agent → update compose metadata (full +
  partial) → agent GET reflects it → same-org member update → 404s.
- CHAIN-BILLING-MEDIA — checkout → status → usage record → invoices.
- CHAIN-FILE — prepare upload → complete → read → download.
- CHAIN-SCHEDULE — deploy → enable → run → disable → delete.

## Migration audit table — AGENT family

Disposition of every legacy case in the agent family. `BDD` = covered by
`agent-lifecycle.bdd.test.ts`; `GAP` = Open Helper Gap (legacy kept until the
gap closes); `KEEP` = retained this round (later round/cross-family).

### `zero-agents-create.test.ts` → **reduced** to the schedule-integration case

The eight CRUD/validation/limit cases moved to BDD; the file keeps only the
create→deploy→enable→run case, which uniquely covers run storage/dispatch source
(`agent-run-storage.service.ts`) not yet reachable through the BDD harness.

| legacy case                                  | disposition                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| 401 unauthenticated                          | BDD (authorization › unauthenticated)                                                   |
| 403 zero token without `agent:write`         | BDD (authorization › capability)                                                        |
| 201 creates agent (+compose/instructions/S3) | BDD (CHAIN-AGENT create); compose-internal/S3 assertions → GAP-COMPOSE-INTERNALS        |
| 400 unknown custom skill                     | BDD (custom skill validation)                                                           |
| 400 built-in connector as custom skill       | BDD (custom skill validation)                                                           |
| 409 public agent limit reached               | BDD (CHAIN-AGENT-LIMIT)                                                                 |
| private excluded from public limit           | BDD (CHAIN-AGENT-LIMIT)                                                                 |
| create after delete frees a slot             | BDD (CHAIN-AGENT-LIMIT)                                                                 |
| schedule executes for created agent          | KEPT — uniquely covers `agent-run-storage.service.ts`; migrates with CHAIN-SCHEDULE/RUN |

### `zero-agents-list.test.ts` → **deleted** (`listAgentsInner$` + `zeroAgentList` fully covered by BDD)

| legacy case                      | disposition                                            |
| -------------------------------- | ------------------------------------------------------ |
| 401 unauthenticated              | BDD (authorization › unauthenticated)                  |
| 401 no active organization       | BDD (authorization › no organization)                  |
| 200 empty list                   | BDD (CHAIN-AGENT-VISIBILITY non-owner sees empty list) |
| 200 lists seeded agent           | BDD (CHAIN-AGENT lists created agent)                  |
| 200 lists agent created via POST | BDD (CHAIN-AGENT)                                      |
| 200 org-scoped only              | BDD (CHAIN-AGENT-VISIBILITY visibility filter)         |

### `zero-agents-by-id.test.ts` → **reduced** to gap/unique-branch cases (CRUD boundaries migrated to BDD)

| legacy case                                                   | disposition                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| get 401 / 401 no-org / 400 bad uuid / 404 unknown / cross-org | BDD (authorization; no-org/uuid/404 are shared branches)                                          |
| get 200 found                                                 | BDD (CHAIN-AGENT)                                                                                 |
| get hides private from non-owner (404)                        | BDD (CHAIN-AGENT-VISIBILITY)                                                                      |
| get accepts owner CLI token (private)                         | GAP-CLI-TOKEN (retained)                                                                          |
| get accepts zero token with `agent:read`                      | GAP-ZERO-TOKEN-CACHE (retained)                                                                   |
| delete 401 / 403 cap / 400 / 404 / cross-org                  | BDD (authorization)                                                                               |
| delete admin deletes public 204 / non-owner 403               | BDD (CHAIN-AGENT, write permissions)                                                              |
| delete owner 204 (storage-less agent)                         | retained — covers the storage-less `deleteComposeById$` branch unreachable via API-created agents |
| delete owner CLI token + storage cleanup                      | GAP-CLI-TOKEN (retained; real-S3 cleanup branch)                                                  |
| delete 409 when a pending run references agent                | GAP-PENDING-RUN (retained)                                                                        |

### `zero-agents-update.test.ts` → **kept** (instructions route lives in a separate source file `zero-agent-instructions.ts`; CLI-token gap)

| legacy case                                                     | disposition                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| PUT 401 / 403 cap / 400 / 404                                   | BDD (authorization)                                        |
| PUT 200 updates + clears stale model fields + preserves omitted | BDD (CHAIN-AGENT)                                          |
| PUT preserves omitted customSkills                              | BDD (CHAIN-AGENT PATCH preserves)                          |
| PUT 400 unknown / built-in skill                                | BDD (custom skill validation)                              |
| PUT 403 non-owner member                                        | BDD (write permissions)                                    |
| PATCH 200 metadata / clears model fields / admin public 200     | BDD (CHAIN-AGENT, write permissions)                       |
| PATCH 403 non-owner / admin private / admin visibility change   | BDD (write permissions)                                    |
| PATCH 409 private→public exceeds limit                          | BDD (CHAIN-AGENT-LIMIT)                                    |
| PUT/PATCH instructions (S3 manifest)                            | KEEP — `zero-agent-instructions.ts`, GAP-INSTRUCTIONS-READ |
| instructions owner CLI token                                    | GAP-CLI-TOKEN                                              |

### `zero-agents.test.ts` → **kept** (user-connectors registry filter)

| legacy case                                             | disposition                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| user-connectors filters types removed from the registry | KEEP — needs injecting a now-removed connector grant; not constructible via API → GAP-REMOVED-CONNECTOR |

### `zero-agent-custom-connectors.test.ts` → **reduced** to the CLI-token case (CHAIN-CONNECTOR migrated to `agent-connectors.bdd.test.ts`)

| legacy case                                       | disposition                                                  |
| ------------------------------------------------- | ------------------------------------------------------------ |
| GET/PUT enabledIds happy + atomic replace + clear | BDD (CHAIN-CONNECTOR)                                        |
| GET/PUT 401 / no-org / 404                        | BDD (agent-connectors authorization)                         |
| PUT 400 cross-org connector id                    | BDD (rejects a custom connector that belongs to another org) |
| GET 403 zero token without `agent:read`           | BDD (agent-connectors authorization)                         |
| GET accepts owner CLI token                       | GAP-CLI-TOKEN (retained here)                                |

### `zero-user-connectors.test.ts` → **reduced** (CHAIN-USER-CONNECTOR migrated to `agent-connectors.bdd.test.ts`)

| legacy case                                | disposition                                 |
| ------------------------------------------ | ------------------------------------------- |
| GET 401 / no-org / 404 / cross-org / empty | BDD (CHAIN-USER-CONNECTOR + authorization)  |
| GET accepts owner CLI token                | GAP-CLI-TOKEN (retained here)               |
| GET ignores removed connector type         | GAP-REMOVED-CONNECTOR (retained here)       |
| GET ignores feature-flag-disabled type     | GAP-FEATURE-GATED-CONNECTOR (retained here) |

### `zero-user-connectors-update.test.ts` → **reduced** (CHAIN-USER-CONNECTOR migrated)

| legacy case                                  | disposition                                           |
| -------------------------------------------- | ----------------------------------------------------- |
| PUT set/persist + replace + dedupe + clear   | BDD (CHAIN-USER-CONNECTOR)                            |
| PUT 400 unavailable / invalid type           | BDD (rejects unavailable and invalid connector types) |
| PUT 401 / no-org / 404 / 403 cap             | BDD (agent user connectors authorization)             |
| PUT skips recomposition when head is current | BDD (CHAIN-USER-CONNECTOR PUTs on a fresh agent)      |
| PUT accepts owner CLI token                  | GAP-CLI-TOKEN (retained here)                         |
| PUT recomposes when head version is stale    | GAP-STALE-RECOMPOSE (retained here)                   |

### `zero-default-agent.test.ts` → **kept** (no read API)

| legacy case                 | disposition                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| all PUT default-agent cases | KEEP — GAP-DEFAULT-AGENT-READ (no GET route exists, so the set/upsert/conflict outcomes are not observable via API) |

## Open Helper Gaps

Behaviours that ARE user-reachable but lack a setup/read API to express them as
API-first BDD. Legacy tests stay alive until the gap closes. None is a license
to read the DB.

- **GAP-CLI-TOKEN** — no API mints a CLI (PAT) token inside a test, so
  "owner CLI token" auth paths can't be set up via API. Needs a test-only
  CLI-token issue helper that wraps the device-auth/API-key flow.
- **GAP-ZERO-TOKEN-CACHE** — the `agent:read` happy path with a zero token
  needs an `org_members_cache` role row; no API populates that cache directly.
- **GAP-DEFAULT-AGENT-READ** — `PUT /api/zero/default-agent` has no GET
  counterpart, so default-agent set/conflict outcomes aren't API-observable.
  Candidate: add a read route (also useful to the product).
- **GAP-INSTRUCTIONS-READ vs S3 manifest** — instructions content is readable
  via `GET /api/agent/composes/:id/instructions`, but the S3 manifest/archive
  shape the legacy test asserts is not API-observable.
- **GAP-COMPOSE-INTERNALS** — created compose version content (env vars,
  volumes) is not API-observable; the BDD create verifies the agent through GET
  instead, and the compose-internal assertions are dropped (code path is still
  executed, so no coverage is lost).
- **GAP-PENDING-RUN** — delete-blocked-by-pending-run needs a run left in
  `pending`; constructing that purely via API depends on the RUN family
  migration (runner admission). Revisit during CHAIN-RUN.
- **GAP-REMOVED-CONNECTOR** — the user-connectors registry filter needs a
  connector grant for a type no longer in the registry; the update API only
  accepts currently-valid types, so the stale grant can't be created via API.
- **GAP-FEATURE-GATED-CONNECTOR** — same shape as above for a valid but
  feature-switch-disabled type (e.g. `spotify`): the update API rejects it, so
  the grant can only be created by DB seeding.
- **GAP-STALE-RECOMPOSE** — the "recompose when the compose head is stale"
  branch needs a forced-stale `headVersionId`; no API exposes or corrupts the
  head version, so staleness can't be induced through the API.
- **GAP-CHAT-MESSAGE-SEED** — the `mark-read` `changed:true` branch (and the
  `changed:false` branch where a stored cursor already matches a real latest
  message) need at least one _visible_ chat message in the thread. The only API
  that persists chat messages is the unified `chat/messages` run endpoint, which
  requires sandbox/run infrastructure, so a bare visible message can't be
  produced through the API. `zero-chat-threads-mark-read.test.ts` is kept for
  those message-bearing branches.

## Service-level exceptions (kept as-is)

Per the issue scope, these stay non-BDD: `custom-eslint/__tests__/`, token
crypto/parsers (`signals/auth/__tests__/tokens.test.ts`,
`services/__tests__/crypto.utils.test.ts`,
`services/__tests__/codex-auth-json-parser.test.ts`), callback-route wrapper
(`lib/callback-route/__tests__/`), log adapters (`lib/__tests__/log.test.ts`,
`sql-span-name`), time (`lib/__tests__/time.test.ts`), memory diff/summarize
(`services/__tests__/memory-activity-*.service.test.ts`), and cron next-run
calc. Services tests outside this list migrate to route-level BDD.

`webhooks-built-in-generations.test.ts` is also kept as-is: it unit-tests pure
provider-failure mapping helpers (`providerFailureDetailsForLog`,
`bytePlusBuiltInGenerationError`) that are only reached by driving a failing
provider generation through the media webhook pipeline (run + provider infra),
so there is no API-first way to exercise just the mapping.

## Drop decisions

- **Connector-owned variable filtering** (`zero-variables.test.ts` "does not
  return connector-owned" / "updates only user-owned when connector same name";
  `zero-variables-delete.test.ts` "deletes only user-owned…" / "404 only
  connector-owned"). Connector-owned variables can't be created through the
  variables API, and the `type = "user"` filter is a SQL `WHERE` clause with no
  unique JS branch — so these are coverage-neutral behavioural duplicates.
  Verified: deleting both files left `zero-secrets.ts` (28/4/4) and
  `zero-variables-delete.ts` (11/2/1) unchanged vs baseline. Dropped along with
  their `seedVariables$`/`seedOtherVariable$` helpers.
- **Connector-/other-user secret filtering and encrypted-storage assertions**
  (`zero-secrets.test.ts` / `zero-secrets-delete.test.ts`). Same shape as
  variables: the `type = "user"` / per-user filters are SQL `WHERE` clauses with
  no unique branch, and the encrypted value is never returned by the API. The
  `set` path still executes the encryption, and the crypto itself is a
  service-level exception (`crypto.utils.test.ts`, 80/26/20 unchanged). Verified
  coverage-neutral: `zero-secrets.ts` (28/4/4) and `zero-secrets-delete.ts`
  (11/2/1) unchanged. Dropped with their `seedSecrets$`/`seedOtherSecret$`
  helpers.
- Compose-internal / S3-manifest assertions are recorded as GAPs above, not
  drops: the underlying code paths remain executed by the BDD tests.

## Round log

### Round 1 — AGENT lifecycle foundation

- Added `helpers/api-bdd.ts` (`createBddApi`) and
  `agent-lifecycle.bdd.test.ts` (CHAIN-AGENT, CHAIN-AGENT-LIMIT,
  CHAIN-AGENT-VISIBILITY + write-permission, custom-skill-validation, and
  authorization matrices) — 11 API-first tests, no DB seeding/assertions.
- Deleted `zero-agents-list.test.ts` and reduced `zero-agents-create.test.ts`
  to its lone schedule-integration case after confirming the removed cases'
  `zero-agents.ts` branches are covered by the BDD tests.
- Established the migration audit table and Open Helper Gaps above. Remaining
  AGENT legacy files are retained pending the enumerated gaps; their CRUD
  boundary duplicates are slated for surgical pruning in the next AGENT round.
- **Coverage verification** (`pnpm -F api exec vitest run --coverage`):
  - Per-file covered counts for the agent source files are unchanged vs the
    `main` baseline: `zero-agents.ts` 253 stmts / 132 branches / 37 funcs,
    `zero-default-agent.ts` 16 / 7 / 1, `zero-agent-data.service.ts` 24 / 5 / 17,
    `agent-compose.service.ts` 56 / 11 / 10,
    `zero-compose-data.service.ts` 85 / 53 / 19.
  - Total covered statements rose (26850 → 26867) and no source file regressed
    below the noise band. v8 coverage of detached-promise files is non-
    deterministic: two runs of identical `main` code produced
    `signals/utils.ts` = 62 then 59 covered statements, so the apparent −3 there
    is run-to-run noise, not a real loss (the branch matches the lower run, and
    its total exceeds both `main` runs). `agent-run-storage.service.ts` stayed at
    baseline (114) because the kept schedule-integration case still exercises it.

### Round 2 — AGENT custom connectors (CHAIN-CONNECTOR)

- Extended `createBddApi` with `customConnectors`
  (`zeroCustomConnectorsContract`) and `agentCustomConnectors`
  (`zeroAgentCustomConnectorsContract`) clients.
- Added `agent-connectors.bdd.test.ts`: CHAIN-CONNECTOR (enable → read → replace
  → clear), a cross-org rejection case, and an authorization matrix — all
  API-first, building the org custom-connector precondition via
  `POST /api/zero/custom-connectors`.
- Reduced `zero-agent-custom-connectors.test.ts` to its CLI-token case
  (GAP-CLI-TOKEN); the GET/PUT enabledIds behaviour is now API-first BDD.
- Coverage: `zero-agents.ts` connector-route branches preserved; the BDD setup
  additionally exercises the custom-connector create route (already covered by
  its own test). Verified ≥ baseline in the round run.

### Round 3 — AGENT user connectors (CHAIN-USER-CONNECTOR)

- Extended `createBddApi` with the `agentUserConnectors`
  (`zeroUserConnectorsContract`) client.
- Added the `agent user connectors` suites to `agent-connectors.bdd.test.ts`:
  CHAIN-USER-CONNECTOR (enable → read → replace → dedupe → clear), unavailable
  /invalid-type rejection, cross-org hiding, and an authorization matrix.
- Reduced `zero-user-connectors.test.ts` to the CLI-token and registry/feature
  -filter cases, and `zero-user-connectors-update.test.ts` to the CLI-token and
  stale-recompose cases (GAP-CLI-TOKEN / GAP-REMOVED-CONNECTOR /
  GAP-FEATURE-GATED-CONNECTOR / GAP-STALE-RECOMPOSE).
- Coverage: `zero-agents.ts` user-connector routes preserved; verified ≥
  baseline in the round run.

### Round 4 — AGENT get/delete pruning

- Reduced `zero-agents-by-id.test.ts` to the gap/unique-branch cases: CLI-token
  and zero-token-with-cache GET, the storage-less delete, the real-S3 cleanup
  delete, and the pending-run 409 — removing the CRUD/boundary cases that the
  BDD suites already cover via shared branches.
- Caught a real −3-branch drop in `zero-compose-data.service.ts` (the
  storage-less `deleteComposeById$` path is only reachable through a
  `seedTeamCompose` agent, never an API-created one) and restored it by keeping
  one storage-less delete case.
- Coverage verified: `zero-agents.ts` 253/132/37 and
  `zero-compose-data.service.ts` 85/53 both back at baseline; total covered
  statements 26850 → 26863. The lone `agent-run-storage.service.ts` branch
  delta (66↔65) is run-to-run noise on a detached-async path (oscillates across
  identical-code runs with statements pinned at 114).

### Round 5 — VARIABLES (CHAIN-VARIABLE)

- First non-AGENT family. Extended `createBddApi` with `variables`
  (`zeroVariablesContract`) and `variableByName` (`zeroVariablesByNameContract`)
  clients.
- Added `zero-variables.bdd.test.ts`: CHAIN-VARIABLE (set → list → update →
  sort → delete → 404) plus invalid-name / unauthenticated / no-org boundaries.
- Deleted `zero-variables.test.ts` and `zero-variables-delete.test.ts` whole
  (the only non-migratable cases were coverage-neutral connector-owned filters —
  see Drop decisions), and removed their now-orphaned `seedVariables$` /
  `seedOtherVariable$` helpers.
- Coverage verified: `zero-secrets.ts` (28/4/4, shared with the SECRET family)
  and `zero-variables-delete.ts` (11/2/1) unchanged vs the `main` baseline;
  total covered statements 26850 → 26859.

### Round 6 — SECRETS (CHAIN-SECRET)

- Extended `createBddApi` with `secrets` (`zeroSecretsContract`) and
  `secretByName` (`zeroSecretsByNameContract`) clients.
- Added `zero-secrets.bdd.test.ts`: CHAIN-SECRET (set → list metadata → update →
  sort → delete → 404) plus invalid-name / empty-value / unauthenticated /
  no-org boundaries.
- Deleted `zero-secrets.test.ts` and `zero-secrets-delete.test.ts` whole and
  removed their now-orphaned `seedSecrets$` / `seedOtherSecret$` helpers (the
  connector-/other-user/encrypted-storage cases are coverage-neutral drops).
- Coverage verified: `zero-secrets.ts` (28/4/4), `zero-secrets-delete.ts`
  (11/2/1) and `crypto.utils.ts` (80/26/20) unchanged vs the `main` baseline.
  The only per-file deltas are the established noise files (`utils.ts` 62↔59,
  `internal-callbacks-chat.ts` 316↔315).

### Round 7 — USER PREFERENCES (CHAIN-USER-PREFERENCES)

- Extended `createBddApi` with the `userPreferences`
  (`zeroUserPreferencesContract`) client.
- Added `zero-user-preferences.bdd.test.ts`: CHAIN-USER-PREFERENCES (GET defaults
  → set all → GET → field-by-field partial updates that each preserve the rest)
  plus invalid-timezone / empty-update / unauthenticated / no-org boundaries.
- Deleted `zero-user-preferences.test.ts` and the now fully-orphaned
  `helpers/zero-user-data.ts` (its last consumer); the family is fully
  API-reachable, so nothing was retained.
- Coverage verified on **source files only** (the raw `total` also counts test
  code, which the migration legitimately removes): source-wide covered
  statements 25039 → 25044, `zero-user-preferences.ts` 16/4/2 unchanged.

### Round 8 — FEATURE SWITCHES (CHAIN-FEATURE-SWITCH)

- Extended `createBddApi` with the `featureSwitches`
  (`zeroFeatureSwitchesContract`) client.
- Added `zero-feature-switches.bdd.test.ts`: CHAIN-FEATURE-SWITCH (GET empty →
  set → merge → override → GET → DELETE clears → GET empty) plus unauthenticated
  / no-org boundaries for all three routes.
- Deleted `zero-feature-switches.test.ts` and the now-orphaned
  `helpers/zero-feature-switches.ts`. Fully API-reachable (GET/POST/DELETE), so
  nothing was retained.
- Coverage verified (source-only): `zero-feature-switches.ts` (18/1/3) and
  `feature-switches.service.ts` (22/4/8) unchanged; source-wide covered
  statements 25039 → 25043.

### Round 9 — API KEYS (CHAIN-API-KEY)

- Extended `createBddApi` with `apiKeys` (`apiKeysContract`) and `apiKeyById`
  (`apiKeysByIdContract`) clients.
- Added `zero-api-keys.bdd.test.ts`: CHAIN-API-KEY (create returns the full
  token once → list exposes only the prefix → second create → newest-first
  order → delete → list excludes → delete again 404), create-body validation
  (empty name / non-positive / above-cap expiry), and unauthenticated / no-org
  boundaries.
- Reduced `zero-api-keys.test.ts` to the sorted-with-`lastUsedAt` case
  (GAP-APIKEY-TIMESTAMPS: controlled clocks + a non-null `lastUsedAt` aren't
  expressible via the API) and deleted `zero-api-keys-delete.test.ts` whole.
- Coverage verified (source-only): `zero-api-keys.ts` (23/2) and
  `zero-api-keys-delete.ts` (11/2) unchanged vs the `main` baseline.

### Round 10 — PERSONAL MODEL PROVIDERS (delete)

- Extended `createBddApi` with `personalModelProviders`
  (`zeroPersonalModelProvidersMainContract`) and `personalModelProviderByType`
  (`zeroPersonalModelProvidersByTypeContract`) clients.
- Added `zero-me-model-providers.bdd.test.ts`: a real upsert → list → delete
  chain (covers the delete handler's 204/404 branches and the list's model-first
  branch) plus unauthenticated / no-org boundaries.
- Deleted `zero-me-model-providers-delete.test.ts` whole. Kept
  `zero-me-model-providers-list.test.ts` (its registry-filter branch needs a
  `codex-oauth-token` provider, which requires the complex OAuth/auth.json
  upsert — GAP-CODEX-UPSERT) and the full `-upsert.test.ts`.
- Coverage verified (source-only): `zero-me-model-providers-delete.ts` (10/2),
  `-list.ts` (8/2) and `-upsert.ts` (28/18) all unchanged vs the `main`
  baseline.
- Also cleaned 60 leftover sentinel `model_stat` rows that an earlier
  interrupted coverage run had left in the shared test DB (caused an unrelated
  `model-stats.test.ts` duplicate-key failure; not a code issue).

### Round 11 — COMPOSE READ (CHAIN-COMPOSE-READ)

- Extended `createBddApi` with the `composesById` (`zeroComposesByIdContract`)
  client.
- Added `zero-composes-by-id.bdd.test.ts`: builds the compose precondition by
  creating an agent through the API (an agent create writes a compose whose id
  is the agent id), then reads it by id and exercises the 404 (unknown),
  400 (malformed id), 401 (unauth / no-org), and cross-org 404 branches.
- Deleted `zero-composes-by-id.test.ts` whole.
- Coverage verified (source-only): `agent-composes-read.ts` (32/15) and the
  other compose route/service files unchanged vs the `main` baseline.

### Round 12 — COMPOSE LIST (CHAIN-COMPOSE-LIST)

- Extended `createBddApi` with the `composesList` (`zeroComposesListContract`)
  client (delete reuses `composesById`).
- Extended `zero-composes-by-id.bdd.test.ts` with list + delete chains: create
  agents → list composes → delete one (204) → list excludes → GET 404, plus the
  unauthenticated / no-org-400 (list) / unknown-404 / cross-org-404 (delete)
  branches.
- Deleted `zero-composes-list.test.ts` whole. Kept `zero-composes-delete.test.ts`
  for its 409 "pending run references the compose" case, which needs a
  DB-seeded pending run (GAP-PENDING-RUN, revisits with the RUN family).
- Coverage verified (source-only): `zero-composes.ts` (45/13) and the other
  compose route/service files unchanged vs the `main` baseline.

### Round 13 — COMPOSE BY NAME (CHAIN-COMPOSE-BY-NAME)

- Extended `createBddApi` with the `composesMain` (`zeroComposesMainContract`)
  getByName client.
- Extended `zero-composes-by-id.bdd.test.ts` with a getByName chain: create
  agent → read its name via getById → getByName returns it, plus unknown-404,
  cross-org-404, and unauthenticated / no-org-401 branches.
- Deleted `zero-composes-by-name.test.ts` whole.
- Coverage verified (source-only): `zero-composes.ts` (45/13) unchanged vs the
  `main` baseline. (An unrelated flaky `cron-summarize-memory` "idempotent on
  rerun" test failed once mid-verification and passed on re-run — not a code
  issue.)

### Round 14 — COMPOSE METADATA (CHAIN-COMPOSE-METADATA)

- Extended `createBddApi` with the `composesMetadata`
  (`zeroComposesMetadataContract`) client.
- Extended `zero-composes-by-id.bdd.test.ts` with metadata-update chains: create
  agent → update metadata (full, then partial preserving the other field) →
  verify through the agent GET → same-org member update → unknown/cross-org 404
  - unauthenticated/no-org 401.
- Reduced `zero-composes-metadata-update.test.ts` to the "fresh zero_agents row"
  case (the upsert INSERT branch, only reachable from a compose with no
  `zero_agents` row; API agents always provision it — GAP-STANDALONE-COMPOSE).
- Coverage verified (source-only): `zero-composes.ts` (45/13) unchanged. This
  completes the COMPOSE family in BDD except the two documented gaps
  (409-pending-run delete, fresh-row INSERT).

### Round 15 — CUSTOM CONNECTORS LIST (CHAIN-CUSTOM-CONNECTOR-LIST)

- Extended `createBddApi` with the `customConnectorSecret`
  (`zeroCustomConnectorSecretContract`) client (`customConnectors` already
  wrapped list/create).
- Added `zero-custom-connectors-list.bdd.test.ts`: empty list → create connector
  → list (hasSecret false) → set a per-user secret via the API → list
  (hasSecret true), plus unauthenticated / no-org 401.
- Deleted `zero-custom-connectors.test.ts` whole; both hasSecret branches are now
  reached through create + secret-set, no DB seeding.
- Coverage verified (source-only): no connector source file changed vs baseline
  (NONE regressions).

### Round 16 — CUSTOM CONNECTORS CRUD (CHAIN-CUSTOM-CONNECTOR)

- Extended `createBddApi` with the `customConnectorById`
  (`zeroCustomConnectorByIdContract`) patch/delete client.
- Added `zero-custom-connectors-crud.bdd.test.ts`: create → list → rename →
  set-secret → delete (cascades the secret) chain, prefix normalisation
  (no-op + add-slash + host wildcard), missing-`{{secret}}` / non-https 400s,
  and an admin-only / unauthenticated / unknown / cross-org matrix for
  create/patch/delete.
- Deleted `zero-custom-connectors-patch.test.ts` and
  `zero-custom-connectors-delete.test.ts` whole. Kept
  `zero-custom-connectors-create.test.ts` for the firewall-validation 400
  branch of `normalizePrefix` (a prefix that is https + parses but fails firewall
  validation — GAP-CONNECTOR-FIREWALL-PREFIX).
- Coverage verified (source-only): `zero-custom-connector.service.ts` (97/49)
  unchanged vs the `main` baseline.

### Round 17 — CUSTOM CONNECTOR SECRETS (CHAIN-CUSTOM-CONNECTOR-SECRET)

- Added `zero-custom-connectors-secret.bdd.test.ts`: create connector → a
  non-admin member sets their own secret → list shows hasSecret → member clears
  it → hasSecret false → clear again (idempotent 204), plus unknown-404,
  unauthenticated, and no-org boundaries.
- Deleted `zero-custom-connectors-secret-set.test.ts`,
  `zero-custom-connectors-secret-delete.test.ts`, and the now fully-orphaned
  `helpers/zero-custom-connectors.ts` DB seeder.
- Coverage verified (source-only): no connector/crypto source file changed vs
  the `main` baseline. This completes the CUSTOM-CONNECTOR family in BDD except
  the create firewall-validation gap (GAP-CONNECTOR-FIREWALL-PREFIX).

### Round 18 — CHAT THREAD METADATA (CHAIN-CHAT-THREAD-METADATA)

- Extended `createBddApi` with chat-thread clients: `chatThreads` (create +
  list), `chatThreadById` (get/patch/delete), `chatThreadPin`,
  `chatThreadUnpin`, `chatThreadRename`, and `chatThreadModelSelection`.
- Added `zero-chat-threads-metadata.bdd.test.ts`: create an agent, open a thread
  on it, then pin -> list shows it in `pinned[]` with `pinnedAt` -> unpin ->
  back in `threads[]` -> rename -> `title`/`renamedAt` via get+list -> pin a
  model (`MODEL_FIRST_SELECTION_PROVIDER_ID` + `claude-sonnet-4-6`) -> detail
  shows `selectedModel` -> clear (null) -> `selectedModel` null again. Plus a
  per-user isolation matrix (cross-user 404 on every route), unknown-404,
  empty-rename / unsupported-model 400s, unauthenticated 401s, and a no-org 401
  for model-selection.
- Deleted `zero-chat-threads-pin.test.ts`, `-unpin.test.ts`, `-rename.test.ts`,
  and `-model-selection.test.ts` whole. Kept `zero-chat-threads-mark-read.test.ts`
  for the message-bearing branches (GAP-CHAT-MESSAGE-SEED).
- Coverage verified (source-only): pin/unpin/model-selection unchanged vs the
  `main` baseline; rename gained a branch (empty-title 400) — no regressions.

### Round 19 — CHAT THREAD CREATE + DRAFT PATCH (CHAIN-CHAT-THREAD-CREATE-PATCH)

- Added `zero-chat-threads-create-patch.bdd.test.ts`: create a thread with a
  title, create a second with a `clientThreadId` (returned verbatim as the row
  id) and no title (→ null), list both, then save a draft (content +
  attachment) → detail reflects it → replace it while still non-empty (no
  presence transition, exercises the no-publish branch of
  `updateChatThreadDraft$`) → clear (null/null). Plus missing-agent 404,
  cross-org-agent 404 (no leak), per-user draft isolation 404 (owner draft
  preserved), unauthenticated 401s, and a no-org create 404.
- Deleted `zero-chat-threads-create.test.ts` and `zero-chat-threads-patch.test.ts`
  whole. Kept `zero-chat-threads-delete.test.ts` (schedule-cascade and in-flight
  run-cancel branches need seeded runs/schedules — GAP-PENDING-RUN /
  GAP-CHAT-SCHEDULE-CASCADE).
- Coverage verified (source-only): `zero-chat-thread.service.ts` (283/206)
  unchanged vs the `main` baseline; create/patch routes unchanged. No
  regressions.

### Round 20 — CHAT THREAD LIST (CHAIN-CHAT-THREAD-LIST)

- Added `zero-chat-threads-list.bdd.test.ts`: create an agent + three threads,
  assert the unified list shape (id / agent.id+avatarUrl / createdAt / updatedAt
  / isRead / running / pinnedAt / renamedAt / hasDraft / totalCount), then pin →
  pinned segment, rename → renamedAt, draft → hasDraft. A second test drives
  cursor pagination (limit overflow → hasMore + nextCursor, second page via
  cursor with the pinned segment omitted, malformed cursor falls back to the
  first page). A third covers agentId scoping, unknown-agent 404, cross-org
  isolation (empty list + 404 on the foreign agent), no-org 401, and
  unauthenticated 401.
- Deleted `zero-chat-threads-list.test.ts` whole (1.3k lines). Its
  running/isRead-by-cursor/scheduleCount value cases assert SQL-computed columns
  (`sql<boolean>` / `sql<number>`) that carry no unique JS branch; deleting the
  whole file left `zero-chat-threads.ts` and `zero-chat-thread.service.ts`
  coverage unchanged (the service even gained a branch), confirmed across two
  full-suite coverage runs. The run/message/schedule value behaviours are a
  drop decision (DROP-CHAT-LIST-SQL-VALUES), not a coverage gap.
- Coverage verified (source-only): no chat-thread source regression vs `main`;
  `zero-chat-thread.service.ts` 283/206 → 284/207. (`slack-connect-blocks.ts`
  oscillates run-to-run and recovered on re-run — added to the noise set.)

### Round 21 — ORG LIST (CHAIN-ORG-LIST)

- Extended `createBddApi` with the `orgList` client and a `mockOrgMemberships`
  helper. Clerk owns organization membership, so the membership set is a
  legitimate external precondition to mock (there is no in-app API to create a
  Clerk org membership) — the helper only stubs
  `clerk.users.getOrganizationMembershipList`.
- Added `zero-org-list.bdd.test.ts`: map a single admin membership, then a
  mixed admin/member set (covers both `mapClerkOrgRole` arms), asserting
  `orgs`/`active` from the real response; plus an unauthenticated 401. Dropped
  the legacy `toHaveBeenCalledWith` mock-interaction assertion in favour of the
  response shape.
- Deleted `zero-org-list.test.ts` whole.
- Coverage verified (source-only): `zero-org-read.ts` (40/13/5) and
  `zero-org-data.service.ts` (199/106/30) unchanged vs `main`. No regressions.

### Round 22 — USER MODEL PREFERENCE (CHAIN-USER-MODEL-PREFERENCE)

- Extended `createBddApi` with the `userModelPreference` (get/update) client.
- Added `zero-user-model-preference.bdd.test.ts`: read null defaults, pin a
  default-configured model (`claude-sonnet-4-6`, provisioned by
  `ensureOrgModelPolicies` for any fresh org — no seeding), read it back, clear
  it; reject a supported-but-unconfigured model (`gpt-5.4` → handler 400
  "Invalid request") and a removed model outside the contract enum
  (`claude-haiku-4-5` → request-validation 400), asserting neither persisted;
  plus unauthenticated and no-org 401s on both verbs.
- The removed-model body is `as unknown as` cast because the ts-rest client is
  typed to the enum and there is no other way to exercise the server-side
  rejection of an out-of-enum model (lints clean).
- Deleted `zero-user-model-preference.test.ts` whole.
- Coverage verified (source-only): `zero-user-model-preference.ts` (20/6/3),
  `zero-model-policy.service.ts` (118/67/30), and `zero-user-data.service.ts`
  (73/49/21) unchanged vs `main`. No regressions.

### Round 23 — SIGNUP ATTRIBUTION (CHAIN-ATTRIBUTION)

- Extended `createBddApi` with the `attribution` client and a
  `mockClerkUserPrivateMetadata` helper (Clerk owns the user profile metadata,
  so the existing metadata is an external precondition to mock).
- Added `zero-attribution.bdd.test.ts`: record first-touch attribution (with
  `mockNow` for a deterministic `recorded_at`) and assert the merge preserves
  prior keys via the Clerk update mock; a second touch with an existing
  `signup_attribution` reports `recorded: false` and writes nothing; plus a
  missing-session 401. `mockNow` is used (not `vi.useFakeTimers`) per the test
  principles, and `recorded` is read from the real response.
- Deleted `zero-attribution.test.ts` whole.
- Coverage verified (source-only): `zero-attribution.ts` (21/8/3) unchanged vs
  `main`. No regressions. (The full coverage run needs `--test-timeout=30000`
  locally because v8 instrumentation slows the unrelated
  `cron-summarize-memory` idempotency test past the default 5s; CI runs tests
  without coverage at full speed.)

### Round 24 — AUTH ME (CHAIN-AUTH-ME)

- Extended `createBddApi` with the `authMe` client, `sandboxAuth(userId)` /
  `zeroAuthFor(userId, capabilities)` token builders (bound to a known userId so
  a Clerk profile mock can match), and `mockClerkUserEmail`.
- Added `auth-me.bdd.test.ts`: resolve the email through a Clerk session and
  re-resolve within the cache window (the second request is served from the
  user cache with no second Clerk fetch); age the cache past its 15-minute TTL
  with `mockNow` and confirm a refreshed Clerk email is returned and re-fetched;
  accept sandbox and zero (file:write / no-capabilities) scoped tokens; and a
  missing-session 401. The cache freshness is driven entirely by real requests
  across `mockNow` rather than by seeding `user_cache`.
- Deleted `auth-me.test.ts` whole.
- Coverage verified (source-only): `auth-me.ts` (28/9/5) unchanged vs `main`.
  No regressions.

### Round 25 — REALTIME TOKEN (CHAIN-REALTIME-TOKEN)

- Extended `createBddApi` with the `realtimeToken` client.
- Added `zero-realtime-token.bdd.test.ts`: mint a token for an authenticated
  caller and assert (via the Ably mock, the only observable surface) that the
  request is a subscribe-only capability scoped to the caller's own
  `user:<id>` channel with the hour TTL; an unauthenticated request is 401 and
  mints nothing. Ably owns token minting, so stubbing `createTokenRequest` is the
  external dependency; the granted capability has no read-back API, so it is
  verified through the mock state per the test principles.
- Deleted `zero-realtime-token.test.ts` whole.
- Coverage verified (source-only): `zero-realtime-token.ts` (11/2/1) and
  `realtime.ts` (38/9/16) unchanged vs `main`. No regressions.
  (`webhooks-stripe.service.ts` oscillates run-to-run and recovered on re-run —
  added to the noise set.)

### Round 26 — DESKTOP UPDATE FEED (CHAIN-DESKTOP-UPDATES)

- Extended `createBddApi` with the `desktopUpdates` client.
- Added `desktop-updates.bdd.test.ts`: serve the current stable macOS arm64
  release, fall back past a blocked `latest` (skip 0.2.2, ignore the newer
  0.3.0 above `latest`, serve 0.2.1), and 404 when no asset matches the
  requested platform/arch. The release manifest is fetched from GitHub (external)
  and injected through the service's `mockDesktopUpdateManifestForTest` seam,
  which overrides the remote content (not internal logic) — the same affordance
  the route already relied on. The feed endpoint is public (no auth).
- Deleted `desktop-updates.test.ts` whole.
- Coverage verified (source-only): `desktop-updates.ts` (8/2/1) and
  `desktop-updates.service.ts` (54/29/13) unchanged vs `main`. No regressions.

### Round 27 — HEALTH (CHAIN-HEALTH)

- Extended `createBddApi` with the `health` and `healthAuth` clients.
- Added `health.bdd.test.ts`: the public health check returns `{status:"ok"}`,
  and the authenticated health check is 401 without credentials. The
  authenticated success paths stay with the auth-probe suite
  (`health-auth-probe.test.ts`), which exercises every credential shape.
- Deleted `health.test.ts` whole.
- Coverage verified (source-only): `health.ts` (3/0) and `health-auth-probe.ts`
  (18/10) unchanged vs `main`. No regressions.

### Round 28 — ORG INVITE (CHAIN-ORG-INVITE)

- Extended `createBddApi` with the `orgInvite` (invite/revoke) client.
- Added `zero-org-invite.bdd.test.ts`: an admin invites with the default role
  (Clerk receives org:member, scoped to org + inviter) and the admin role
  (org:admin), and revokes an invitation; non-admin members get 403,
  unauthenticated and no-org requests 401, invalid email / missing invitationId
  400, and none of the rejected paths reach Clerk. Clerk owns the invitation
  lifecycle, so the role/identity mapping is verified through the Clerk
  invitation mock and the message via the real response.
- Deleted `zero-org-invite.test.ts` whole.
- Coverage verified (source-only): `zero-org-invite.ts` (28/10/2) unchanged vs
  `main`. No regressions.

### Round 29 — ORG MEMBERSHIP REQUESTS (CHAIN-ORG-MEMBERSHIP-REQUESTS)

- Extended `createBddApi` with the `membershipRequests` (accept/reject) client.
- Added `zero-org-membership-requests.bdd.test.ts`: an admin accepts and rejects
  a request (the Clerk REST endpoint is mocked with MSW and its hit count is
  asserted), a Clerk 404 surfaces as a 400, and the admin-only / unauthenticated
  / no-org / invalid-body matrix is enforced before Clerk is ever called. The
  invalid-body cases use a typed-client cast (the contract requires
  `requestId`).
- Deleted `zero-org-membership-requests.test.ts` whole.
- Coverage verified (source-only): `zero-org-membership-requests.ts` (31/12/2)
  and `zero-org-membership-requests.service.ts` (16/8/2) unchanged vs `main`. No
  regressions.

### Round 30 — BILLING REDEEM CODE (CHAIN-BILLING-REDEEM-CODE)

- Extended `createBddApi` with the `billingRedeemCode` client.
- Added `zero-billing-redeem-code.bdd.test.ts`: an admin redeems a code through
  the external Atom service (MSW-mocked) using a Clerk M2M token — asserting the
  trimmed code + org id in the outbound Atom request, the M2M minting params, and
  the `{redeemed:true}` response; non-admin/unauthenticated callers never touch
  Atom; missing ATOM_URL / machine secret, M2M failure, and an unreachable Atom
  all surface as 503s; and every Atom rejection shape (404, already_used,
  expired, org_mismatch, unknown business error, malformed JSON) maps to its
  stable bad-request message. Env is driven by `mockEnv`/`mockOptionalEnv`.
- Deleted `zero-billing-redeem-code.test.ts` whole.
- Coverage verified (source-only): `zero-billing-redeem-code.ts` (70/42/9) and
  `zero-billing-redeem.service.ts` (89/31/7) unchanged vs `main`. No regressions.

### Round 31 — ORG LOGO (CHAIN-ORG-LOGO)

- Extended `createBddApi` with the `orgLogo` (get/delete) client; the multipart
  upload is issued as a raw request through the app.
- Added `zero-org-logo.bdd.test.ts`: read the org logo (present + cleared,
  asserting the Clerk lookup); upload a logo (asserting the file forwarded to
  Clerk) and a cleared image; validate the file (no file / not a file / too
  large / unsupported type); and enforce the unauthenticated / no-org /
  non-admin / zero-token matrix on read+upload+delete while mapping Clerk
  not-found and bad-request errors to 404 and forbidden to 403. Clerk owns the
  org image, so each result is read from the real response and verified through
  the Clerk mock.
- Deleted `zero-org-logo.test.ts` whole.
- Coverage verified (source-only): `zero-org-logo.ts` (60/46/8) unchanged vs
  `main`. No regressions.

### Round 32 — TEAM LISTING (CHAIN-TEAM)

- Extended `createBddApi` with the `team` client.
- Added `zero-team.bdd.test.ts`: a fresh org has an empty team; an agent created
  with skills + metadata is listed in full (id / ownerId / displayName /
  description / sound / avatarUrl / customSkills / visibility / headVersionId /
  updatedAt); the team is scoped to the active org and shows every public agent
  plus the caller's own private agents while excluding other members' private
  agents and other orgs' agents (all members + agents built via the public
  agents/skills API across `actAsAdmin`/`actAsMember`); and unauthenticated 401 /
  no-org 403 boundaries.
- Deleted `zero-team.test.ts` whole. The "compose without zero-agent metadata"
  exclusion is a SQL join filter (GAP-STANDALONE-COMPOSE) with no unique JS
  branch — deleting the whole legacy left `zero-team.ts` (8/2/1) unchanged
  (DROP-TEAM-STANDALONE-COMPOSE).
- Coverage verified (source-only): `zero-team.ts` (8/2/1) unchanged vs `main`.
  No regressions.

### Round 33 — RUN CREATE REJECTIONS (CHAIN-RUN-CREATE-REJECTIONS, reduce-legacy)

First reduce-legacy on a gap family. A probe established that an API-created
agent in a fresh org returns 402 INSUFFICIENT*CREDITS — the funded happy path
needs credits granted via billing/redeem webhooks (no public API), so the run
happy path and all downstream run operations stay gap-blocked (GAP-RUN-CREDITS).
But every rejection \_before* the credit check is reachable.

- Extended `createBddApi` with the `zeroRuns` client.
- Added `zero-runs-create.bdd.test.ts`: unauthenticated 401; a zero token
  without `agent-run:write` and a plain sandbox token both 403; body validation
  (missing agentId 400, caller permissionPolicies 400, ambiguous Claude tool
  entries 400); unknown sessionId 404; a fresh-org VM0 run 402
  INSUFFICIENT_CREDITS; and a non-owner running a private agent 403.
- Reduced `zero-runs-create.test.ts` from 54 to 46 cases by removing the 8
  seedless rejection cases now covered by the BDD (and their orphaned
  `generateZeroToken` import + `sandboxToken` helper); kept the seeded-credit and
  connector/secret/model happy-path cases (GAP-RUN-CREDITS).
- Coverage verified (source-only): no regression; `agent-run-create.service.ts`
  561 -> 563 branches (the fresh-org admission path is newly covered).

### Round 34 — BILLING PORTAL REJECTIONS (CHAIN-BILLING-PORTAL, reduce-legacy)

- Extended `createBddApi` with the `billingPortal` client.
- Added `zero-billing-portal.bdd.test.ts`: unauthenticated 401; non-admin 403;
  Stripe-not-configured 503 (env-driven, done last as it mutates env); and
  returnUrl validation (missing 400, malformed 400, foreign-origin 400). The
  Stripe-config check runs after auth + role, so the env-mutating case is
  ordered last.
- Reduced `zero-billing-portal.test.ts` from 7 to 1 case, keeping only the
  funded success path (opens a Stripe portal for the org's existing
  `stripeCustomerId`, which needs a DB-seeded customer — GAP-STRIPE-CUSTOMER).
  The kept success case now calls `mockStripeClient(context.mocks.stripe)`
  explicitly (the per-call Stripe SDK override) so it self-primes instead of
  relying on test-ordering — a latent coupling the original masked.
- Coverage verified (source-only): `zero-billing-portal.ts` (18/8/1) and
  `billing.service.ts` (28/31/4) unchanged vs `main`. No regressions.

### Round 35 — BILLING INVOICES (CHAIN-BILLING-INVOICES, reduce-legacy)

- Extended `createBddApi` with the `billingInvoices` client.
- Added `zero-billing-invoices.bdd.test.ts`: unauthenticated 401, no-org 401,
  non-admin 403, and an empty list for an org with no Stripe customer (asserting
  Stripe is never called via `mockListStripeInvoices`).
- Reduced `zero-billing-invoices.test.ts` from 6 to 2 cases, keeping the two
  funded paths (invoices for an org with a seeded Stripe customer/subscription,
  and the empty-with-customer case) — both need a DB-seeded customer
  (GAP-STRIPE-CUSTOMER).
- Coverage verified (source-only): `zero-billing-invoices.ts` (8/2) and
  `zero-billing-invoices.service.ts` (8/2) unchanged vs `main`. No regressions.

### Round 36 — SCHEDULE MUTATIONS REJECTIONS (CHAIN-SCHEDULE-MUTATIONS, reduce-legacy)

- Extended `createBddApi` with the `scheduleEnable` (enable/disable) and
  `scheduleByName` (delete) clients.
- Added `zero-schedules-mutations.bdd.test.ts`: for enable, disable, and delete —
  an unknown schedule on an API-created agent is 404, a missing agentId body/query
  is 400, and unauthenticated is 401; delete additionally rejects a zero token
  without `schedule:delete` (403, before any lookup).
- Reduced three legacy files: `zero-schedules-enable.test.ts` 6 -> 3,
  `zero-schedules-disable.test.ts` 5 -> 2, `zero-schedules-delete.test.ts` 6 -> 2,
  removing the reachable rejection cases (and orphaned token helpers). The kept
  cases enable/disable/delete an actual deployed schedule, which needs the
  external scheduler (GAP-SCHEDULE-DEPLOY).
- Coverage verified (source-only): `zero-schedules.ts` (68/26) and
  `zero-schedules.service.ts` (257/165) unchanged vs `main`. No regressions.

### Round 37 — RUN READ/CANCEL/QUEUE REJECTIONS (CHAIN-RUN-READ-CANCEL-QUEUE, reduce-legacy)

- Extended `createBddApi` with the `zeroRunsById`, `zeroRunsCancel`, and
  `zeroQueuePosition` clients.
- Added `zero-runs-read-cancel-queue.bdd.test.ts`: get-by-id rejects
  unauthenticated/no-org 401, malformed-uuid 400, unknown-run 404, and a zero
  token without `agent-run:read` 403; cancel rejects unauthenticated/no-org 401,
  a zero token without `agent-run:write` 403, and unknown-run 404;
  queue-position rejects a missing runId (400, raw request) and unauthenticated
  401, and 404s an unknown run.
- Reduced `zero-runs-by-id.test.ts` 7 -> 2, `zero-runs-cancel.test.ts` 18 -> 14,
  `zero-queue-position.test.ts` 7 -> 4, removing the reachable rejections (and
  orphaned `currentSecond`/token-builder helpers). The kept cases operate on
  seeded runs (success, cross-user/cross-org, cancel scenarios) — runs need
  credits with no API surface (GAP-RUN-CREDITS).
- Coverage verified (source-only): `zero-queue-position.ts` (9/2),
  `zero-runs-cancel.ts` (14/4), `queue-position.service.ts` (10/5), and
  `zero-run-cancel.service.ts` (38/16) unchanged vs `main`. No regressions.

### Round 38 — ORG DELETE REJECTIONS (CHAIN-ORG-DELETE, reduce-legacy)

- Extended `createBddApi` with the `orgDelete` client.
- Added `zero-org-delete.bdd.test.ts`: unauthenticated 401, no-org 401, and a
  zero-token 403 (Clerk untouched); a non-admin member 403; an admin with a
  missing slug 400; an admin whose confirmation slug does not match the Clerk
  org 400; and a 404 when Clerk `getOrganization` reports no identity. The org
  identity + slug come from the Clerk mock and the role from the session, so all
  rejections are reachable without seeding.
- Reduced `zero-org-delete.test.ts` from 8 to 1 case, keeping only the
  successful cascade delete (deletes through Clerk and cleans member-local rows),
  which seeds org cache / integrations / members (GAP-ORG-DELETE-CASCADE).
- Coverage verified (source-only): `zero-org-delete.ts` (13/4) unchanged;
  `zero-org-data.service.ts` 199/106 -> 204/118 (the Clerk-mock rejection paths
  cover more `deleteZeroOrg$` branches than the legacy). No regressions.

### Round 39 — ORG GET/UPDATE/LEAVE REJECTIONS (CHAIN-ORG-CRUD-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `org` (get/update) and `orgLeave` clients.
- Added `zero-org-crud-rejections.bdd.test.ts`: get rejects unauthenticated 401
  and no-org 404; update rejects unauthenticated 401, no-org 400, and a sandbox
  token 403; leave rejects unauthenticated 401, no-org 400, a sandbox token 403,
  and an admin 403 ("Admins cannot leave the organization"). All these fire
  before any org row is resolved, so no seeding is needed.
- Reduced `zero-org.test.ts` from 28 to 19 cases, removing the nine reachable
  rejections (across the GET / PUT / leave describe blocks). The kept cases read
  or mutate seeded org metadata — tier, identity cache, slug validation,
  not-member checks, Clerk update/leave success (GAP-ORG-STATE).
- Coverage verified (source-only): `zero-org-read.ts` (40/13) unchanged;
  `zero-org-data.service.ts` 199/106 -> 204/118. No regressions.

### Round 40 — BILLING CHECKOUT REJECTIONS (CHAIN-BILLING-CHECKOUT-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `billingCheckout` client.
- Added `zero-billing-checkout-rejections.bdd.test.ts`: unauthenticated 401,
  no-org 401, non-admin 403, invalid-tier 400, and Stripe-not-configured 503 —
  all of which reject before the Stripe price lookup.
- Reduced `zero-billing-checkout.test.ts` from 28 to 23 cases, removing the five
  reachable create-block rejections (kept the complete-checkout block's separate
  non-admin 403). The kept cases drive funded success, tier transitions, trial,
  completion and credit checkouts that need seeded org/Stripe state
  (GAP-STRIPE-CUSTOMER / GAP-ORG-TIER). The three `beforeEach` blocks now prime
  `mockStripeClient(context.mocks.stripe)` so the kept Stripe cases self-prime
  the per-call SDK override instead of relying on test-ordering.
- Coverage verified (source-only): `zero-billing-checkout.ts` (51/27),
  `billing.service.ts` (28/31), and `zero-billing-checkout.service.ts` (84/47)
  unchanged vs `main`. No regressions.

### Round 41 — BILLING DOWNGRADE/RESTORE REJECTIONS (CHAIN-BILLING-TIER-CHANGE-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `billingDowngrade` and `billingRestore`
  clients.
- Added `zero-billing-tier-change-rejections.bdd.test.ts`: downgrade rejects
  unauthenticated 401, non-admin 403, invalid targetTier 400, an org with no
  subscription 409, and Stripe-not-configured 503; restore rejects
  unauthenticated 401, non-admin 403, no-subscription 409, and 503. A fresh org
  has no Stripe subscription, so the 409 is reachable without seeding.
- Reduced `zero-billing-downgrade.test.ts` 15 -> 10 and
  `zero-billing-restore.test.ts` 8 -> 4, removing the reachable rejections. The
  kept cases downgrade/restore a real subscription (same-or-higher tier guard,
  not-scheduled, restore success), which need a seeded Stripe subscription
  (GAP-STRIPE-SUBSCRIPTION).
- Coverage verified (source-only): `zero-billing-downgrade.ts` (25/15),
  `zero-billing-restore.ts` (23/14), and their services (102/54, 26/14)
  unchanged vs `main`. No regressions. This rounds out the BILLING family
  (redeem-code, portal, invoices, checkout, downgrade, restore).

### Round 42 — BILLING AUTO-RECHARGE DEFAULT + ROUTE REJECTIONS (CHAIN-BILLING-AUTO-RECHARGE-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `billingAutoRecharge` (get/update) client.
- Added `zero-billing-auto-recharge-rejections.bdd.test.ts`: GET reads the legacy
  default for an org with no metadata row (`{enabled:false, threshold:null,
amount:null}`) and rejects unauthenticated/no-org reads 401; PUT rejects
  unauthenticated 401 and non-admin 403 (the route role check, before any billing
  work).
- Reduced `zero-billing-auto-recharge.test.ts` from 17 to 12 cases, removing only
  the auth/no-org/legacy-default/non-admin cases. The threshold/amount validation
  cases stay in the kept legacy: they run _inside_ `updateAutoRechargeConfig$`
  after the tier is resolved from seeded org metadata, so a fresh org can't reach
  them (it short-circuits on the paid-tier guard) — converting them would drop a
  `billing.service.ts` statement (caught and corrected via the coverage gate).
- Coverage verified (source-only): `zero-billing-auto-recharge.ts` (22/8) and
  `billing.service.ts` (28/31) unchanged vs `main`. No regressions.

### Round 43 — ORG MEMBERS REJECTIONS (CHAIN-ORG-MEMBERS-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `orgMembers` (members/updateRole/removeMember)
  client.
- Added `zero-org-members-rejections.bdd.test.ts`: list rejects unauthenticated
  401, no-org 401, and a zero token without billing:read 403; updateRole and
  removeMember each reject unauthenticated 401, no-org 401, a sandbox token 403,
  an invalid email 400, and a non-admin 403 ("Access denied"). All fire before
  any Clerk membership work.
- Reduced `zero-org-members.test.ts` from 26 to 13 cases, removing the 13
  reachable rejections across the GET / PATCH / DELETE blocks (and the orphaned
  raw-request helper). The kept cases list real members and update/remove a
  resolved member, reading Clerk membership + user profiles
  (GAP-CLERK-MEMBERSHIP).
- Coverage verified (source-only): `zero-org-members.ts` (25/9) unchanged vs
  `main`. No regressions. This completes the ORG family (list, invite,
  membership-requests, logo, team, delete, get/update/leave, members).

### Round 44 — GITHUB INSTALLATION READ REJECTIONS (CHAIN-GITHUB-GET-REJECTIONS, reduce-legacy)

First INTEGRATION-family reduce.

- Extended `createBddApi` with the `githubIntegration` client.
- Added `integrations-github-get-rejections.bdd.test.ts`: unauthenticated 401, a
  zero token without github:read 403, and a 404 "No GitHub installation found"
  (with a null install URL when there is no seeded default-agent org context to
  derive one from).
- Reduced `integrations-github-get.test.ts` from 16 to 14 cases, removing the
  unauthenticated and capability rejections. The kept cases need a connected
  GitHub App installation / seeded org context for the install URL
  (GAP-GITHUB-INSTALL).
- Coverage verified (source-only): `integrations-github.ts` (45/5) unchanged vs
  `main`. No regressions.

### Round 45 — UPLOAD PREPARE REJECTIONS (CHAIN-UPLOADS-PREPARE-REJECTIONS, reduce-legacy)

First STORAGE-family reduce.

- Extended `createBddApi` with the `uploads` (prepare/complete) client.
- Added `zero-uploads-prepare-rejections.bdd.test.ts`: unauthenticated 401, a
  zero token without file:write 403, and body/size/content-type validation
  (empty filename 400, >1 GB 400 "File too large", unsupported type 400).
- Reduced `zero-uploads-prepare.test.ts` from 12 to 7 cases, removing the
  reachable rejections. The kept cases sign a presigned URL (S3 + seeded org
  tier, GAP-UPLOAD-PRESIGN). Because removing the leading 401 made a presigning
  case the first test, the kept block now primes `s3.getSignedUrl` in a
  `beforeEach` (the shared mock seed runs in afterEach) — a latent
  test-ordering coupling the original masked.
- Coverage verified (source-only): `zero-uploads-prepare.ts` (26/10) and
  `zero-uploads-complete.ts` (31/19) unchanged vs `main`. No regressions.

### Round 46 — UPLOAD COMPLETE REJECTIONS (CHAIN-UPLOADS-COMPLETE-REJECTIONS, reduce-legacy)

- Added `zero-uploads-complete-rejections.bdd.test.ts` (reusing the `uploads`
  client): unauthenticated 401, a zero token without file:write 403, a non-uuid
  id 400, and an unsupported content type 400.
- Reduced `zero-uploads-complete.test.ts` from 12 to 8 cases, removing the
  reachable rejections. The kept cases record uploads + run/chat-thread
  associations against a prepared upload + S3 object (GAP-UPLOAD-COMPLETE).
- Coverage verified (source-only): `zero-uploads-complete.ts` (31/19) unchanged
  vs `main`. No regressions. Completes the STORAGE uploads pair (prepare +
  complete).

### Round 47 — USAGE RUNS DEFAULT + REJECTIONS (CHAIN-USAGE-RUNS-REJECTIONS, reduce-legacy)

First USAGE-family reduce.

- Extended `createBddApi` with the `usageRuns` client.
- Added `zero-usage-runs-rejections.bdd.test.ts`: unauthenticated 401, non-admin
  403, an empty page for an org with no processed usage (both unscoped and for a
  known runId), and a malformed runId 400.
- Reduced `zero-usage-runs.test.ts` from 15 to 10 cases, removing the reachable
  rejections + empty-result cases. The kept cases report populated per-run
  credit records, which need seeded runs + processed usage events
  (GAP-USAGE-EVENTS).
- Coverage verified (source-only): `zero-usage-runs.ts` (12/4) unchanged vs
  `main`. No regressions. (Note: module-scope mutable objects trip the custom
  `api/no-package-variable` lint rule — expose them as functions in test files.)

### Round 48 — CONNECTOR-BY-TYPE READ REJECTIONS (CHAIN-CONNECTOR-BY-TYPE-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `connectorByType` (get/delete) client.
- Added `zero-connectors-by-type-get-rejections.bdd.test.ts`: unauthenticated
  401, no-org 401, and a 404 for an org with no connector of the requested type.
- Reduced `zero-connectors-by-type-get.test.ts` from 6 to 3 cases. The kept
  cases return a connected connector / legacy-secret variants, which need a
  seeded connector row from the OAuth/manual connect flow (GAP-CONNECTOR-CONNECT).
- Coverage verified (source-only): `zero-connector-data.service.ts` (389/136)
  unchanged vs `main`. No regressions.

### Round 49 — CONNECTOR DELETE/SCOPE-DIFF REJECTIONS (CHAIN-CONNECTOR-BY-TYPE-MUTATIONS-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `connectorScopeDiff` client (the
  `connectorByType` client already exposes `delete`).
- Added `zero-connectors-by-type-mutations-rejections.bdd.test.ts`: delete
  rejects unauthenticated/no-org 401 and 404s an unconnected type ("Connector
  not found"); scope-diff rejects unauthenticated/no-org 401, a zero token
  without connector:read 403, and 404s an unconnected type.
- Reduced `zero-connectors-by-type-delete.test.ts` (11 -> 8) and
  `zero-connectors-scope-diff.test.ts` (8 -> 4), removing the reachable
  rejections (and the orphaned token helpers). The kept cases delete a connected
  connector / diff stored-vs-current scopes (GAP-CONNECTOR-CONNECT).
- Coverage verified (source-only): `zero-connector-data.service.ts` (389/136)
  unchanged vs `main`. No regressions.

### Round 50 — RUN-LOG LIST REJECTIONS (CHAIN-LOGS-LIST-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `logsList` client (`/api/logs`).
- Added `zero-logs-list-rejections.bdd.test.ts`: the list rejects
  unauthenticated and org-less callers (401) and returns an empty page
  (`data: []`, `hasMore` false, `nextCursor` null) for a fresh org with no runs.
- The out-of-range-limit / non-UUID-agentId validations return a 400 that the
  `logsListContract.list` response map does not declare, so the ts-rest client
  throws on it; those validation cases need the raw-fetch helper and stay in the
  kept legacy alongside the rows/cursor/agent-filter/cross-user variants, which
  need funded runs that emit logs (GAP-RUN-CREDITS).
- Reduced `zero-logs-list.test.ts` (43 -> 40), removing the auth + empty cases.
- Coverage verified (source-only): no regressions vs `main`.

### Round 51 — RUN-LOG DETAIL REJECTIONS (CHAIN-LOGS-BY-ID-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `logsById` client (`/api/zero/logs/:id`).
- Added `zero-logs-get-by-id-rejections.bdd.test.ts`: the detail endpoint
  rejects unauthenticated and org-less callers (401), a zero token without
  `agent-run:read` (403, "Missing required capability: agent-run:read", checked
  before any run lookup), and 404s an unknown run id ("Log not found").
- The 200 detail variants (owner / displayName / pending / failed /
  schedule-linked / deleted-compose) need a funded run that emits logs
  (GAP-RUN-CREDITS), the other-user 404 needs a seeded foreign run, and the
  invalid-UUID 400 is a status `logsByIdContract` does not declare (the ts-rest
  client throws on it, so it keeps the raw-fetch helper). Those stay in the kept
  legacy.
- Reduced `zero-logs-get-by-id.test.ts` (16 -> 11).
- Coverage verified (source-only): no regressions vs `main`.

### Round 52 — RUN-LOG SEARCH REJECTIONS (CHAIN-LOGS-SEARCH-REJECTIONS, reduce-legacy)

- Extended `createBddApi` with the `logsSearch` (`/api/logs/search`, session)
  and `zeroLogsSearch` (`/api/zero/logs/search`, zero-token) clients.
- Added `zero-logs-search-rejections.bdd.test.ts`: the session search rejects
  unauthenticated and org-less callers (401) and returns an empty result for an
  `agentId` filter that matches no run (short-circuits before Axiom is queried —
  asserted via `context.mocks.axiom.query` not being called); the zero search
  rejects unauthenticated callers (401) and a zero token without `agent-run:read`
  (403).
- A keyword search that returns matches needs seeded runs plus an Axiom mock
  (GAP-RUN-CREDITS); the zero-token empty-agent path 500s on a synthetic org, so
  only the session empty path is converted. The matched/context/runId/limit/
  cross-org variants stay in the kept legacy.
- Reduced `logs-search.test.ts` (13 -> 10, dropped the now-orphaned
  `randomUUID` import) and `zero-logs-search.test.ts` (14 -> 12).
- Coverage verified (source-only): no regressions vs `main`.
