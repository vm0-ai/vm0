# API Testing Patterns

## Principle

In the API app (`turbo/apps/api`), route behavior should be covered by
**API route integration tests**. These tests exercise the real Hono app through
`setupApp()`, an explicit route slice, and the route's ts-rest contract, not by
importing route handlers or service functions directly.

Use this guide for endpoints implemented in `apps/api` or promoted to
API-authoritative behavior.

## File Location

Place route tests under the API route test directory:

```text
turbo/apps/api/src/signals/routes/__tests__/
+-- agents.test.ts
```

## Route Test Structure

```typescript
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentsRoutes } from "../agents";

const context = testContext();

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsMainContract);
}

describe("GET /api/agents", () => {
  it("returns an agent created through POST /api/agents", async () => {
    context.mocks.clerk.session("user_api_test", "org_api_test");
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Listed Agent",
          description: "desc",
          sound: "friendly",
        },
      }),
      [201],
    );

    const listed = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(listed.body).toContainEqual(
      expect.objectContaining({
        agentId: created.body.agentId,
        ownerId: "user_api_test",
        displayName: "Listed Agent",
        description: "desc",
        sound: "friendly",
      }),
    );
  });
});
```

Key points:

1. Import the contract from `@okouai/api-contracts` and the matching route array,
   then call it through `setupApp({ context, routes })(contract)`.
2. Use `accept()` to narrow the response type and produce useful failure output.
3. Put `testContext()` at module scope.
4. Use API calls for setup and verification.
5. Mock only auth identity and external services through `context.mocks`.

## What To Test

Route tests should cover user-visible HTTP behavior:

- authentication and organization membership
- validation failures that callers can hit
- permission and no-existence-leak behavior
- success response bodies and status codes
- persisted side effects through follow-up API calls
- external service calls at the boundary, using the centralized mocks

`setupApp()` creates the Hono app with only the declared route slice and validates
ts-rest responses. This keeps tests independent from the production bootstrap
registry while preserving the real route behavior. A route test should fail if
the handler returns a body that no longer matches the contract.

## Mocks

Only mock external services. API tests use the shared mock registry in
`turbo/apps/api/src/__tests__/mocks.ts` and reset it from
`turbo/apps/api/src/__tests__/setup.ts`.

Good examples:

```typescript
context.mocks.clerk.session(userId, orgId);
context.mocks.slack.chat.postMessage.mockResolvedValue({ ok: true });
context.mocks.axiom.query.mockResolvedValue({ buckets: [] });
```

Avoid `vi.mock()` for internal modules such as services, route files, database
schemas, fixture helpers, or ccstate signals. That bypasses the behavior the
route integration test is supposed to cover.

## External Behavior Boundary

API route tests should construct cases through API endpoints and verify results
through API endpoints. The endpoint is the external contract. The database and
service layer are internal implementation.

Do not import DB schemas, write database rows, read database rows for assertions,
or call services from API tests. Those tests couple to table shape, service
boundaries, and internal state transitions instead of the behavior external
callers rely on.

If a case is not constructible through the production API surface, do not add an
API route test that reaches into internals. Add the missing API surface first, or
raise the gap during review.

For the full reasoning, see
[Testing External Behavior](./testing-external-behavior.md).

## Shared Persistent State

Teardown cannot establish correctness for shared persistent state. Another
file or worker can observe, overwrite, or depend on that state before
`afterEach` or `onTestFinished` runs, and a crashed test may not run teardown at
all. A test must therefore be correct while other API tests execute
concurrently, even if its cleanup has not happened yet.

Give every test uniquely owned, explicitly addressable users, organizations,
providers, storage identities, external entities, cache namespaces, and rows.
When a production cron scans a global table, keep production behavior global
but drive correctness through a test-only route whose request names the owned
IDs. Production-global routes may be mounted only by the focused contract
harness for fixed missing/wrong-auth assertions. Do not isolate tests with a
global lock, test ordering, worker serialization, broad clock partitions,
snapshot/restore of shared rows, or residue-tolerant assertions.

Operator-managed usage-pricing identities and the fixed production staff
organization are shared production data. Use `createUsagePricingFixture()` to
map a logical canonical provider to a UUID-owned physical lookup row, and use a
unique organization fixture for entitlement writes. Fixed production
identities remain valid in read-only/hash/auth behavior. Raw pricing mutation
helpers are only for providers already proven UUID-, run-, or fixture-owned.

Cache assertions own their key or namespace. Set and advance mocked time inside
the test that exercises the TTL; never stagger tests with a module- or
describe-scoped counter to outlive another test's cache entry. Process-wide
caches and overrides need an explicit request/test owner and scoped reset
semantics, such as an `AbortSignal` or async-local boundary.

Cleanup is still useful after ownership establishes correctness. It may remove
rows and resources created by that test, and it should terminate or release
test-owned handles, `AbortController`s/signals, MSW handlers, connections,
sockets/streams, detached work, and temporary files. Such cleanup bounds
residue and resource lifetime; it must not delete, overwrite, or restore
pre-existing shared state to make an assertion pass.

## Commands

Run route-focused tests from `turbo`:

```shell
pnpm -F api exec vitest run src/signals/routes/__tests__/agents.test.ts
pnpm -F api lint
pnpm -F api check-types
```

Run one Vitest process at a time.
