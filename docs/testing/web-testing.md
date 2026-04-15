# Web Testing Patterns

## Principle

In the web app (`turbo/apps/web`), only write **Web Route Integration Tests** (`route.test.ts` files) - test API endpoints only.

## File Location

Test files should be placed in `__tests__/route.test.ts` next to the corresponding `route.ts`.

```
app/api/agent/runs/
├── route.ts
└── __tests__/
    └── route.test.ts
```

## Test File Structure

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST, GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/agent/runs", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const { composeId } = await createTestCompose(`agent-${Date.now()}`);
    testComposeId = composeId;
  });

  it("should create a run with pending status", async () => {
    // Given - fixtures prepared in beforeEach

    // When - execute the behavior under test
    const data = await createTestRun(testComposeId, "Test prompt");

    // Then - assert the result
    expect(data.status).toBe("pending");
    expect(data.runId).toBeDefined();
  });
});
```

---

## Import

Avoid importing any internal services - this usually means using internal implementation to build fixtures.

**Bad Case**

```typescript
import { RunService } from "../../../lib/run/run-service";
import { AgentSessionService } from "../../../lib/agent-session/agent-session-service";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposes } from "../../../db/schema/agent-compose";
import { orgCache } from "../../../db/schema/org-cache";
import { credentials } from "../../../db/schema/credential";
import { eq } from "drizzle-orm";
import { encryptCredentialValue } from "../../../lib/crypto";
```

**Good Case**

```typescript
import { POST, GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestModelProvider,
  completeTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
```

---

## Mock

Place `vi.mock` calls immediately after the import section. Only mock external services.

**Bad Case**

```typescript
// Mocking internal services
vi.mock("../../../lib/run/run-service", () => ({
  RunService: vi.fn().mockImplementation(() => ({
    buildExecutionContext: vi.fn(),
    checkConcurrencyLimit: vi.fn(),
  })),
}));

vi.mock("../../../lib/agent-session", () => ({
  agentSessionService: {
    getByIdWithConversation: vi.fn(),
  },
}));
```

**Good Case**

```typescript
// Only mock external services
vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
```

---

## Test Context

`testContext()` should be called after the mock section, outside of all describe blocks.

```typescript
vi.mock("@clerk/nextjs/server");
// ... other mocks

const context = testContext(); // Outside all describe blocks

describe("...", () => {
  beforeEach(() => {
    context.setupMocks(); // Set up default mock behavior for S3, Axiom, etc.
  });
});
```

`testContext()` provides:

- `setupMocks()` - Set up default mock behavior for external services
- `setupUser()` - Create isolated user context (unique userId and orgId)
- `mocks` - Access mock objects for customization or assertions

---

## beforeEach

Use beforeEach within a describe block to consolidate repeated fixture setup:

```typescript
describe("POST /api/agent/runs", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(`agent-${Date.now()}`);
    testComposeId = composeId;
  });

  it("test 1", async () => {
    /* ... */
  });
  it("test 2", async () => {
    /* ... */
  });
});
```

---

## Avoid DB Operations

Similar to importing internal services, direct DB operations for data setup often mean testing scenarios that can't occur in real usage.

**Bad Case - Direct database operations**

```typescript
// Creating data
await globalThis.services.db.insert(orgCache).values({
  orgId: testOrgId,
  slug: `test-${testOrgId.slice(0, 8)}`,
});

await globalThis.services.db.insert(agentComposes).values({
  id: testAgentId,
  name: testAgentName,
  userId: testUserId,
  orgId: testOrgId,
});

// Modifying state
await globalThis.services.db
  .update(agentRuns)
  .set({ status: "completed" })
  .where(eq(agentRuns.id, runId));

// Cleaning up data
await globalThis.services.db
  .delete(agentRuns)
  .where(eq(agentRuns.userId, testUserId));
```

**Good Case - Via API helpers**

```typescript
// Create data via API
const user = await context.setupUser();
const { composeId } = await createTestCompose("test-agent");
const { runId } = await createTestRun(composeId, "test prompt");

// State transitions via webhooks
await completeTestRun(user.userId, runId);

// No cleanup needed - user isolation handles it
```

---

## No initServices in Route Tests

Route tests should never call `initServices()` directly. If you're properly using API helpers for data operations and verification, `initServices()` is not needed - the route handlers themselves call it internally.

**Bad Case**

```typescript
import { initServices } from "../../../lib/init-services";

describe("POST /api/agent/runs", () => {
  beforeEach(async () => {
    initServices(); // Don't do this
    // ...
  });
});
```

**Good Case**

```typescript
describe("POST /api/agent/runs", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    // No initServices() - API helpers handle it
  });
});
```

If you find yourself needing `initServices()`, it's a sign that you're accessing the database directly instead of through API helpers.

---

## State Transitions

Run state transitions should be done via webhook helpers, not direct database modifications:

```typescript
// Create run (status automatically set to pending)
const { runId } = await createTestRun(composeId, "test prompt");

// Complete run (via checkpoint + complete webhook)
await completeTestRun(user.userId, runId);
```

---

## Test Target

Only test route-level integration tests (primary) and pure functions (exception only):

| Type                            | Location                | Examples                                     |
| ------------------------------- | ----------------------- | -------------------------------------------- |
| **Web Route Integration Tests** | `app/.../route.test.ts` | Validation, authorization, business logic    |
| Pure function tests (exception) | `lib/.../xxx.test.ts`   | Extremely complex algorithmic functions only |

```typescript
// Route-level test
describe("POST /api/agent/runs", () => {
  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });
    const request = createTestRequest(url, { method: "POST", body: "..." });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });
});

// Pure function test
describe("calculateSessionHistoryPath", () => {
  it("handles workspace path", () => {
    const result = calculateSessionHistoryPath("/workspace", "session-123");
    expect(result).toBe("/workspace/.claude/sessions/session-123.jsonl");
  });
});
```

---

## Pure Function Test Guidelines (Rare Exception)

Pure function tests are a **rare exception**, reserved only for:

- **Security-critical functions** (cryptographic operations, token validation, permission checks)
- **Extremely complex algorithms** where bugs would have severe consequences

**NOT allowed** (test via Web Route Integration Tests instead): validators, parsers, formatters, simple utilities.

These tests should be simple and isolated - no mocks, no database operations, no external dependencies.

**Bad Case**

```typescript
import { vi } from "vitest";
import { initServices } from "../../../lib/init-services";
import { formatPath } from "../path-utils";

vi.mock("@clerk/nextjs/server");

describe("formatPath", () => {
  beforeEach(() => {
    initServices(); // Pure functions don't need services
  });

  it("formats path correctly", () => {
    const result = formatPath("/workspace", "file.txt");
    expect(result).toBe("/workspace/file.txt");
  });
});
```

**Good Case**

```typescript
import { describe, it, expect } from "vitest";
import { formatPath } from "../path-utils";

describe("formatPath", () => {
  it("formats path correctly", () => {
    const result = formatPath("/workspace", "file.txt");
    expect(result).toBe("/workspace/file.txt");
  });

  it("handles trailing slash", () => {
    const result = formatPath("/workspace/", "file.txt");
    expect(result).toBe("/workspace/file.txt");
  });
});
```

If your "pure function" test requires mocks or database access, either:

1. The function isn't actually pure - move the test to a route test
2. You're testing implementation details - refactor to test behavior through APIs

---

## Acceptable Service-Level Test Exceptions

While route integration tests are the default, some service-level tests are acceptable when no API route exists for the functionality. These tests still follow the same principles — real database, only mock external dependencies — but import service functions directly.

### When Service-Level Tests Are Acceptable

1. **No API route exists** — The function is internal infrastructure with no HTTP endpoint
2. **Auth/middleware logic** — Runs before route handlers, can't be tested through routes alone
3. **Internal state manipulation** — Queue operations, state machines, optimistic locking
4. **Webhook/callback handlers** — Triggered by external services, not HTTP requests from clients
5. **Cleanup/cascade operations** — Org/user deletion triggered by Clerk webhooks

### Exception Categories

#### Auth/Middleware

Tests for auth context resolution, middleware validation, capability checking:

- `auth/__tests__/get-auth-context-cli.test.ts`
- `auth/__tests__/get-auth-context-zero.test.ts`
- `auth/__tests__/get-auth-context.spec.ts`
- `auth/__tests__/require-auth.test.ts`
- `auth/__tests__/org-membership-cache.test.ts`

#### Internal Infrastructure

Tests for caching, scheduling, storage that have no API route:

- `auth/__tests__/org-cache.test.ts`
- `auth/__tests__/user-cache-service.test.ts`
- `infra/callback/__tests__/dispatcher.test.ts`
- `infra/run/__tests__/scheduling.test.ts`
- `infra/storage/__tests__/instruction-upload.test.ts`
- `infra/storage/__tests__/system-skill-resolution.test.ts`

#### Complex Business Logic

OAuth flows, message context building, webhook handlers:

- `zero/connector/providers/__tests__/slack.test.ts`
- `zero/connector/providers/__tests__/spotify.test.ts`
- `zero/slack/__tests__/context.test.ts`
- `zero/telegram/__tests__/context.test.ts`
- `zero/slack-org/handlers/__tests__/shared.test.ts`

#### Internal Queue/State Machine

Tests requiring direct queue manipulation:

- `zero/__tests__/build-zero-context.test.ts`
- `zero/__tests__/run-queue-service.test.ts`
- `zero/email/__tests__/outbox-service.test.ts`
- `infra/run/__tests__/run-status.test.ts`
- `zero/__tests__/credit-check.test.ts`

#### Webhook-triggered Cascade Operations

Clerk webhook handlers with complex cleanup:

- `zero/org/__tests__/org-deletion-service.test.ts`
- `zero/org/__tests__/org-external-cleanup.test.ts`
- `zero/user/__tests__/user-deletion-service.test.ts`
- `zero/user/__tests__/user-external-cleanup.test.ts`

#### Org-level Functions Without API Routes

Functions only accessible internally:

- `zero/secret/__tests__/org-secret-service.test.ts`
- `zero/variable/__tests__/org-variable-service.test.ts`
- `zero/org/__tests__/org-service.test.ts`
- `zero/user/__tests__/load-feature-switch-overrides.test.ts`
- `zero/billing/__tests__/auto-recharge-service.test.ts`
- `zero/credit/__tests__/credit-expiry.test.ts`
- `zero/org/__tests__/org-metadata-service.test.ts`
- `zero/credit/__tests__/member-credit-cap-service.test.ts`

### How to Add a New Exception

If the ESLint rule flags a service import in your test file:

1. First verify no route exists — check `app/api/` for a handler that wraps the function
2. If a route exists, migrate the test to use the route handler (see Web Route Integration Tests above)
3. If no route exists, add an eslint-disable comment with a documented reason:

```typescript
// eslint-disable-next-line web/no-direct-db-in-tests -- Auth middleware has no route handler
import { getAuthContext } from "../get-auth-context";
```

---

## Test Cleanup

Don't manually delete - this creates order dependencies. `testContext()` handles user isolation, no cleanup needed.

**Bad Case**

```typescript
afterEach(async () => {
  await globalThis.services.db
    .delete(checkpoints)
    .where(eq(checkpoints.runId, run.id));
  await globalThis.services.db
    .delete(conversations)
    .where(eq(conversations.runId, run.id));
  await globalThis.services.db
    .delete(agentRuns)
    .where(eq(agentRuns.userId, testUserId));
  // ... more cleanup, order must be correct
});
```

**Good Case**

```typescript
// No cleanup code needed
// context.setupUser() creates unique userId each time
// Data is naturally isolated by unique IDs
```

---

## MSW with Mock Tracking

For testing code that calls external HTTP APIs (e.g., Slack API), use the custom MSW wrapper at `src/__tests__/msw.ts`.

### Why a Custom Wrapper?

The wrapper provides:

1. **Automatic request cloning** - Request body remains available for test assertions
2. **Mock tracking** - Each handler is wrapped with `vi.fn()` for call verification
3. **Type-safe handler keys** - Return type preserves handler names for autocomplete

### Basic Usage

```typescript
import { HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { handlers, http } from "../../__tests__/msw";

const SLACK_API = "https://slack.com/api";

// Define handlers with mock tracking
const slackHandlers = handlers({
  postMessage: http.post(
    `${SLACK_API}/chat.postMessage`,
    async ({ request }) => {
      const body = await request.formData();
      const data = Object.fromEntries(body.entries());
      return HttpResponse.json({
        ok: true,
        ts: `${Date.now()}.000000`,
        channel: data.channel,
      });
    },
  ),
  reactionsAdd: http.post(`${SLACK_API}/reactions.add`, () =>
    HttpResponse.json({ ok: true }),
  ),
});

describe("My Feature", () => {
  beforeEach(() => {
    server.use(...slackHandlers.handlers);
  });

  it("should call the API", async () => {
    // ... trigger the code that calls the API

    // Verify the mock was called
    expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
  });
});
```

### Reading Request Data from Mock Calls

The wrapper automatically clones requests, so you can read the request body in test assertions:

```typescript
/** Helper to get form data from a mock's call */
async function getFormData(
  mock: { mock: { calls: Array<[{ request: Request }]> } },
  callIndex = 0,
): Promise<Record<string, FormDataEntryValue>> {
  const request = mock.mock.calls[callIndex]![0].request;
  const body = await request.formData();
  return Object.fromEntries(body.entries());
}

it("should send correct data", async () => {
  // ... trigger the code

  expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

  // Read the request body that was sent
  const data = await getFormData(slackHandlers.mocked.postMessage);
  expect(data.channel).toBe("C123");
  expect(data.text).toContain("Hello");
});
```

### API Reference

#### `http.post(predicate, resolver, options?)`

Creates a POST handler with mock tracking. Also available: `http.get`, `http.put`, `http.delete`.

Returns: `{ handler: HttpHandler; mocked: Mock }`

#### `handlers(mockedHandlers)`

Aggregates multiple handlers and extracts their mocks:

```typescript
const result = handlers({
  foo: http.post("/foo", ...),
  bar: http.get("/bar", ...),
});

// result.handlers: HttpHandler[] - Pass to server.use()
// result.mocked.foo: Mock - Vitest mock for foo handler
// result.mocked.bar: Mock - Vitest mock for bar handler
```

The return type preserves handler keys for TypeScript autocomplete.

---

## Domain-Specific Test Helpers

For complex integrations (e.g., Slack, OAuth), create domain-specific BDD-style helpers that use API endpoints instead of direct DB operations.

### Location

Place domain helpers in `src/__tests__/<domain>/`:

```
src/__tests__/
├── api-test-helpers.ts    # Generic helpers (createTestCompose, etc.)
├── slack/
│   ├── index.ts           # Re-exports
│   └── api-helpers.ts     # Slack-specific helpers
```

### Pattern: Given Helpers

Create `given*` helpers that set up preconditions through real API flows:

```typescript
// src/__tests__/slack/api-helpers.ts
import { HttpResponse } from "msw";
import { handlers, http } from "../msw";
import { server } from "../../mocks/server";
import { createTestCompose, createTestOrg } from "../api-test-helpers";
import { mockClerk } from "../clerk-mock";

// Import route handlers and server actions
import { GET as oauthCallbackRoute } from "../../../app/api/slack/oauth/callback/route";
import { linkSlackAccount } from "../../../app/slack/link/actions";

/**
 * Given a Slack workspace has installed the app.
 * Uses OAuth callback route with mocked Slack API.
 */
export async function givenSlackWorkspaceInstalled(
  options: WorkspaceInstallationOptions = {},
): Promise<WorkspaceInstallationResult> {
  // Mock external Slack OAuth API
  const oauthMock = handlers({
    oauthAccess: http.post("https://slack.com/api/oauth.v2.access", () =>
      HttpResponse.json({
        ok: true,
        access_token: "xoxb-test-token",
        bot_user_id: options.botUserId ?? "B123",
        team: { id: options.workspaceId ?? "T123", name: "Test Workspace" },
      }),
    ),
  });
  server.use(...oauthMock.handlers);

  // Call the actual OAuth callback route
  const request = new Request("http://localhost/api/slack/oauth/callback?code=mock-code");
  await oauthCallbackRoute(request);

  return { installation: { slackWorkspaceId: options.workspaceId ?? "T123", ... } };
}

/**
 * Given a Slack user has linked their account.
 * Uses server action with mocked Clerk auth.
 */
export async function givenLinkedSlackUser(
  options: LinkedUserOptions = {},
): Promise<LinkedUserResult> {
  const { installation } = await givenSlackWorkspaceInstalled(options);

  // Mock Clerk and create org
  mockClerk({ userId: options.vm0UserId ?? "user-123" });
  await createTestOrg("test-org");

  // Call the actual server action
  await linkSlackAccount(options.slackUserId ?? "U123", installation.slackWorkspaceId);

  return { installation, userLink: { ... } };
}
```

### Usage in Tests

```typescript
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../../src/__tests__/slack";

describe("POST /api/slack/events", () => {
  it("should execute agent when mentioned", async () => {
    // Given - BDD-style setup through API helpers
    const { userLink, installation } = await givenLinkedSlackUser();
    await givenUserHasAgent(userLink, { agentName: "my-helper" });

    // When - call the route under test
    const request = createSlackEventRequest({ ... });
    const response = await POST(request);

    // Then
    expect(response.status).toBe(200);
  });
});
```

### Bad Case - Direct DB Operations in Helpers

```typescript
// ❌ Don't do this - bypasses validation, auth, and business logic
export async function givenLinkedSlackUser() {
  initServices();

  // Direct DB insert - skips OAuth flow validation
  await globalThis.services.db.insert(slackInstallations).values({
    slackWorkspaceId: "T123",
    encryptedBotToken: encryptCredentialValue("xoxb-token", key),
    botUserId: "B123",
  });

  // Direct DB insert - skips auth and link validation
  await globalThis.services.db.insert(slackUserLinks).values({
    slackUserId: "U123",
    slackWorkspaceId: "T123",
    vm0UserId: "user-123",
  });

  return { ... };
}
```

### Bad Case - Testing Internal Functions Instead of Routes

```typescript
// ❌ Don't do this - tests internal implementation, not API contract
import { handleAppMention } from "../../../lib/slack/handlers/mention";

describe("handleAppMention", () => {
  it("should respond to mention", async () => {
    // Testing internal function directly
    await handleAppMention(event, installation, userLink);
  });
});
```

```typescript
// ✅ Do this - test the route endpoint
import { POST } from "../route";

describe("POST /api/slack/events", () => {
  it("should respond to mention", async () => {
    const request = createSlackEventRequest({ ... });
    const response = await POST(request);
    expect(response.status).toBe(200);
  });
});
```

### Bad Case - Mocking Internal Modules

```typescript
// ❌ Don't do this - mocking internal modules hides bugs
import * as runAgentModule from "../../../lib/slack/handlers/run-agent";

vi.spyOn(runAgentModule, "runAgentForSlack").mockResolvedValue({
  response: "mocked response",
});

it("should run agent", async () => {
  await POST(request);
  expect(runAgentModule.runAgentForSlack).toHaveBeenCalled();
});
```

```typescript
// ✅ Do this - mock only external services, verify behavior through response
vi.mock("@clerk/nextjs/server"); // External service

it("should run agent", async () => {
  const response = await POST(request);

  // Verify behavior through actual response content
  const data = await getFormData(slackHandlers.mocked.postMessage);
  expect(data.text).toContain("agent response");
});
```

### Benefits

1. **Tests real flows** - Fixtures are created through the same paths as production
2. **Catches integration bugs** - DB schema changes, validation rules, etc. are automatically tested
3. **Self-documenting** - `givenLinkedSlackUser()` clearly describes the precondition
4. **No internal coupling** - Helpers don't import internal services or DB schemas
