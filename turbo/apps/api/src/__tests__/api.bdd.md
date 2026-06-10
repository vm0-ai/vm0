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

## Service-level exceptions (kept as-is)

Per the issue scope, these stay non-BDD: `custom-eslint/__tests__/`, token
crypto/parsers (`signals/auth/__tests__/tokens.test.ts`,
`services/__tests__/crypto.utils.test.ts`,
`services/__tests__/codex-auth-json-parser.test.ts`), callback-route wrapper
(`lib/callback-route/__tests__/`), log adapters (`lib/__tests__/log.test.ts`,
`sql-span-name`), time (`lib/__tests__/time.test.ts`), memory diff/summarize
(`services/__tests__/memory-activity-*.service.test.ts`), and cron next-run
calc. Services tests outside this list migrate to route-level BDD.

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
