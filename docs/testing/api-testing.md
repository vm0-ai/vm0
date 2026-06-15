# API Testing Patterns

## Principle

In the API app (`turbo/apps/api`), route behavior should be covered by
**API route integration tests**. These tests exercise the real Hono app through
`setupApp()` and the route's ts-rest contract, not by importing route handlers or
service functions directly.

Use this guide for endpoints implemented in `apps/api`, migrated from
`apps/web`, or promoted to API-authoritative behavior.

## File Location

Place route tests under the API route test directory:

```text
turbo/apps/api/src/signals/routes/__tests__/
+-- zero-runs-runner.test.ts
+-- helpers/
    +-- zero-route-test.ts
```

Shared fixture helpers for one route family belong in
`turbo/apps/api/src/signals/routes/__tests__/helpers/`. Keep helpers scoped to
the route family unless there is already a reusable helper with the same shape.

## Route Test Structure

```typescript
import { randomUUID } from "node:crypto";

import { zeroRunRunnerContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/runs/:id/runner", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns the sandbox reuse result", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
        sandboxReuseResult: "reused",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunRunnerContract);

    const response = await accept(
      client.getRunner({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ sandboxReuseResult: "reused" });
  });

  it("returns 404 when the run does not exist", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunRunnerContract);

    const response = await accept(
      client.getRunner({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Agent run not found",
        code: "NOT_FOUND",
      },
    });
  });
});
```

Key points:

1. Import the contract from `@vm0/api-contracts`, then call it through
   `setupApp({ context })(contract)`.
2. Use `accept()` to narrow the response type and produce useful failure output.
3. Put `testContext()` and `createStore()` at module scope.
4. Mock auth and external services through `context.mocks` or focused helper
   wrappers such as `createZeroRouteMocks(context)`.
5. Use fixture helpers and `createFixtureTracker()` for setup and cleanup when
   the state is not reachable through an existing route.

## What To Test

Route tests should cover user-visible HTTP behavior:

- authentication and organization membership
- validation failures that callers can hit
- permission and no-existence-leak behavior
- success response bodies and status codes
- persisted side effects when the response alone is not enough
- external service calls at the boundary, using the centralized mocks

`setupApp()` creates the Hono app with the real route registry and validates
ts-rest responses. A route test should fail if the handler returns a body that no
longer matches the contract.

## Mocks

Only mock external services. API tests use the shared mock registry in
`turbo/apps/api/src/__tests__/mocks.ts` and reset it from
`turbo/apps/api/src/__tests__/setup.ts`.

Good examples:

```typescript
mocks.clerk.session(userId, orgId);
context.mocks.slack.chat.postMessage.mockResolvedValue({ ok: true });
context.mocks.axiom.query.mockResolvedValue({ buckets: [] });
```

Avoid `vi.mock()` for internal modules such as services, route files, database
helpers, or ccstate signals. That bypasses the behavior the route integration
test is supposed to cover.

## Fixtures And Database State

Prefer creating state through routes when a route exists. When a route needs
database state that is not reachable through public HTTP behavior, use focused
ccstate fixture helpers under `__tests__/helpers/`.

Fixture helpers should:

- create unique `orgId` and `userId` values
- insert the minimum state needed for the route behavior
- expose a cleanup command used through `createFixtureTracker()`
- keep raw database operations out of the test body when possible

Direct database reads in a test body are acceptable when they verify a persisted
side effect that is not visible in the HTTP response. Direct writes should live
in fixture helpers unless the setup is truly one-off and smaller than a helper.

## Service-Level Exceptions

Route tests are the default. A service-level test is acceptable only when there
is no HTTP route that exercises the behavior, or when the behavior runs before a
route handler can execute.

Typical exceptions:

- auth or middleware resolution
- cron and internal queue operations without a client route
- webhook verification helpers without a public wrapper
- external client adapters
- complex pure functions or state-machine transition tables

If a route wraps the service, test through the route.

## Migration From apps/web

All endpoint behavior lives in `apps/api`. `apps/web` no longer hosts API route
handlers, so the web app keeps only compatibility coverage for routing concerns,
such as:

- exact `API_BACKEND_REWRITES` entries
- middleware bypass matchers
- security header behavior around proxied paths

Do not add an `apps/web/app/api/**/route.ts` proxy (a custom `no-new-api-routes`
lint rule forbids it). Route the web-compatible path back to `apps/api` through
the API backend rewrite configuration.

## Commands

Run route-focused tests from `turbo`:

```shell
pnpm -F api exec vitest run src/signals/routes/__tests__/zero-runs-runner.test.ts
pnpm -F api lint
pnpm -F api check-types
```

Run one Vitest process at a time.
