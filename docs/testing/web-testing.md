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
vi.mock("@e2b/code-interpreter");
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

  it("should create a run with running status", async () => {
    // Given - fixtures prepared in beforeEach

    // When - execute the behavior under test
    const data = await createTestRun(testComposeId, "Test prompt");

    // Then - assert the result
    expect(data.status).toBe("running");
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
import { scopes } from "../../../db/schema/scope";
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
vi.mock("@e2b/code-interpreter");
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
    context.setupMocks(); // Set up default mock behavior for E2B, S3, Axiom, etc.
  });
});
```

`testContext()` provides:

- `setupMocks()` - Set up default mock behavior for external services
- `setupUser()` - Create isolated user context (unique userId and scopeId)
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
await globalThis.services.db.insert(scopes).values({
  id: testScopeId,
  slug: `test-${testScopeId.slice(0, 8)}`,
  type: "personal",
  ownerId: testUserId,
});

await globalThis.services.db.insert(agentComposes).values({
  id: testAgentId,
  name: testAgentName,
  userId: testUserId,
  scopeId: testScopeId,
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
// Create run (status automatically set to running)
const { runId } = await createTestRun(composeId, "test prompt");

// Complete run (via checkpoint + complete webhook)
await completeTestRun(user.userId, runId);

// Test failure scenarios - mock Sandbox creation failure
vi.mocked(Sandbox.create).mockRejectedValueOnce(new Error("Sandbox failed"));
const data = await createTestRun(composeId, "test");
expect(data.status).toBe("failed");
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
