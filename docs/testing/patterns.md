# Testing Patterns

This document describes our standard testing patterns. These aren't arbitrary conventions—they're the patterns that have proven to work well for our codebase, helping us write tests that give real confidence while remaining maintainable.

## Pattern 1: API Route Tests

Our most common test type. When testing Next.js API route handlers, we follow a specific structure that has evolved through practice.

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

// ========== MOCKS SECTION ==========
// Only mock EXTERNAL third-party packages
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

// ========== TEST CONTEXT ==========
const context = testContext();

// ========== TEST SUITE ==========
describe("POST /api/agent/runs", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  it("should create a run with running status", async () => {
    const data = await createTestRun(testComposeId, "Test prompt");

    expect(data.status).toBe("running");
    expect(data.runId).toBeDefined();
  });
});
```

The key points:

1. **Mocks at the top, before imports**. Vitest hoists `vi.mock()` calls, so putting them at the top makes the hoisting explicit.

2. **Only mock external dependencies**. Clerk, E2B, S3, Axiom are third-party SaaS requiring API keys. Our internal services use real implementations.

3. **`testContext()` outside describe blocks**. This provides `setupMocks()` for external service mocks and `setupUser()` for isolated user context.

4. **No `vi.clearAllMocks()` needed**. Vitest is configured with `clearMocks: true`, so mocks are automatically cleared between tests.

5. **No `initServices()` in route tests**. Route handlers call `initServices()` internally. If you need it in tests, it means you're accessing the database directly instead of through API helpers.

6. **No database cleanup needed**. `context.setupUser()` creates a unique userId each time, so data is naturally isolated.

7. **Use API helpers for fixtures**. Create test data via `createTestCompose()`, `createTestRun()`, etc. instead of direct database operations.

8. **Assert HTTP responses, not database state**. Test the behavior through the API, not internal implementation details.

### Variations

**Webhook endpoints** need double auth setup:

```typescript
beforeEach(() => {
  // First call: Check CLI token (returns null)
  // Second call: Check Clerk auth
  mockAuth
    .mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>)
    .mockResolvedValueOnce({ userId: testUserId } as Awaited<
      ReturnType<typeof auth>
    >);
});
```

**Multi-user scenarios** use multiple `setupUser()` calls:

```typescript
let user1: UserContext;
let user2: UserContext;

beforeEach(async () => {
  context.setupMocks();
  user1 = await context.setupUser({ prefix: "user1" });
  user2 = await context.setupUser({ prefix: "user2" });
});
```

---

## Pattern 2: Pure Function Tests

We rarely write unit tests for pure functions—integration tests usually exercise them adequately. But for security-critical or algorithmically complex code, unit tests make sense.

```typescript
import { describe, it, expect } from "vitest";
import { calculateTotal, formatDate } from "./utils";

describe("calculateTotal", () => {
  it("should sum positive numbers", () => {
    expect(calculateTotal([1, 2, 3])).toBe(6);
  });

  it("should handle empty array", () => {
    expect(calculateTotal([])).toBe(0);
  });

  it("should ignore negative numbers", () => {
    expect(calculateTotal([1, -2, 3])).toBe(4);
  });
});
```

Note what's absent: no mocks, no `beforeEach`/`afterEach` if there's no state. Pure function tests are simple because pure functions are simple.

**When to use this pattern**:

- Security-critical functions (cryptographic operations, token validation, permission checks)
- Complex algorithms where bugs would have severe consequences

**When NOT to use this pattern**:

- Validators, parsers, formatters (exercise through integration tests)
- Simple utility functions
- Any function that can be exercised through route/command integration tests

Default to integration tests. Only create unit tests when there's a strong security or complexity justification.

---

## Pattern 3: MSW HTTP Mocking

When your code makes HTTP requests to external APIs, use MSW to mock them at the network level.

**Handler setup**:

```typescript
// mocks/handlers/api-handlers.ts
import { http, HttpResponse } from "msw";

export const apiHandlers = [
  // GET with params
  http.get("https://api.example.com/users/:id", ({ params }) => {
    const { id } = params;
    return HttpResponse.json({ id, name: "Test User" }, { status: 200 });
  }),

  // POST with request body
  http.post("https://api.example.com/users", async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({ id: "new-id", ...body }, { status: 201 });
  }),

  // Error simulation
  http.get("https://api.example.com/error", () => {
    return HttpResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }),

  // Network error simulation
  http.get("https://api.example.com/network-error", () => {
    return HttpResponse.error();
  }),
];
```

**Test file usage**:

```typescript
import { server } from "../../mocks/server";

// No server.listen()/resetHandlers()/close() needed - global setup.ts handles lifecycle

it("should fetch user data", async () => {
  const user = await fetchUser("123");
  expect(user.name).toBe("Test User");
});

it("should handle API errors", async () => {
  // Override handler for specific test
  server.use(
    http.get("https://api.example.com/users/:id", () => {
      return HttpResponse.json({ error: "Not found" }, { status: 404 });
    }),
  );

  await expect(fetchUser("999")).rejects.toThrow("Not found");
});
```

MSW provides realistic HTTP behavior—status codes, headers, streaming—and tests actual request construction. The MSW server lifecycle (`listen`, `resetHandlers`, `close`) is managed by the global `setup.ts`, so test files should NOT include those calls.

---

## Pattern 4: Real Filesystem Testing

When testing code that reads or writes files, use real filesystems with temp directories.

```typescript
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

it("should write config file", () => {
  const configPath = join(tempDir, "config.json");

  writeConfig(configPath, { setting: "value" });

  // Verify actual file was written
  const content = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(content.setting).toBe("value");
});

it("should read existing config", () => {
  const configPath = join(tempDir, "config.json");

  // Setup: Write real file
  writeFileSync(configPath, JSON.stringify({ setting: "value" }));

  // Test: Read real file
  const config = readConfig(configPath);
  expect(config.setting).toBe("value");
});
```

This pattern catches real bugs—permission issues, race conditions, encoding problems—that filesystem mocks would hide.

---

## Pattern 5: Mock Helpers

When the same mock setup appears in multiple test files, extract it into a reusable helper.

**Clerk Mock Helper** (`turbo/apps/web/src/__tests__/clerk-mock.ts`):

```typescript
import { vi } from "vitest";
import { auth } from "@clerk/nextjs/server";

const mockAuth = vi.mocked(auth);

export function mockClerk(options: { userId: string | null }) {
  mockAuth.mockResolvedValue({
    userId: options.userId,
  } as Awaited<ReturnType<typeof auth>>);
}

export function clearClerkMock() {
  mockAuth.mockClear();
}
```

**Usage patterns**:

```typescript
import { mockClerk, clearClerkMock } from "@/__tests__/clerk-mock";

beforeEach(() => {
  mockClerk({ userId: testUserId });
});

afterEach(() => {
  clearClerkMock();
});

// Override for specific test
it("should reject unauthenticated request", () => {
  mockClerk({ userId: null });
  // ...
});
```

The helper reduces boilerplate and ensures consistent mock setup across test files.

---

## Pattern 6: Environment Variable Stubbing

For tests that depend on environment variables, use `vi.stubEnv()`:

```typescript
beforeEach(() => {
  vi.stubEnv("API_KEY", "test-key");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("should use environment variable", () => {
  expect(process.env.API_KEY).toBe("test-key");

  const config = loadConfig();
  expect(config.apiKey).toBe("test-key");
});
```

This is cleaner than the manual save/restore approach:

```typescript
// Don't do this
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.VM0_TOKEN;
  process.env.TEST_SECRET = "value";
});

afterEach(() => {
  process.env = originalEnv;
});
```

The `vi.stubEnv()` approach provides proper cleanup and better test isolation with less code.

---

## Pattern 7: Platform Component Tests

Our platform app uses ccstate for state management and requires tests to follow the production initialization flow. This pattern uses centralized test helpers that mirror `main.ts` startup.

### Test Infrastructure

**1. Centralized Clerk Mock** (`src/__tests__/mock-auth.ts`):

```typescript
import { vi } from "vitest";

let internalMockedUser: { id: string; fullName: string } | null = null;
let internalMockedSession: { token: string } | null = null;

export function mockUser(
  user: { id: string; fullName: string } | null,
  session: { token: string } | null,
) {
  internalMockedUser = user;
  internalMockedSession = session;
}

export function clearMockedAuth() {
  internalMockedUser = null;
  internalMockedSession = null;
}

export const mockedClerk = {
  get user() {
    return internalMockedUser;
  },
  get session() {
    return {
      getToken: () => Promise.resolve(internalMockedSession?.token ?? ""),
    };
  },
  load: () => Promise.resolve(),
  addListener: () => () => {},
  redirectToSignIn: vi.fn(),
};
```

**2. Global Test Setup** (`src/test/setup.ts`):

```typescript
import "@testing-library/jest-dom/vitest";
import { server } from "../mocks/server.ts";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { mockedClerk } from "../__tests__/mock-auth.ts";

vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return mockedClerk;
  },
}));

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

**3. Page Setup Helper** (`src/__tests__/helper.ts`):

```typescript
import { act, render } from "@testing-library/react";
import type { TestContext } from "../signals/__tests__/test-helpers";
import { clearMockedAuth, mockUser } from "./mock-auth";
import { bootstrap$ } from "../signals/bootstrap";
import { setupRouter } from "../views/main";
import { setPathname } from "../signals/location";

export async function setupPage(options: {
  context: TestContext;
  path: string;
  user?: { id: string; fullName: string } | null;
  session?: { token: string } | null;
}) {
  setPathname(options.path);

  mockUser(
    options.user !== undefined
      ? options.user
      : { id: "test-user-123", fullName: "Test User" },
    options.session ?? { token: "test-token" },
  );
  options.context.signal.addEventListener("abort", () => {
    clearMockedAuth();
  });

  const rootEl = document.createElement("div");
  document.body.appendChild(rootEl);
  options.context.signal.addEventListener("abort", () => {
    rootEl.remove();
  });

  await act(async () => {
    await options.context.store.set(
      bootstrap$,
      () => {
        setupRouter(options.context.store, (element) => {
          render(element, { container: rootEl });
        });
      },
      options.context.signal,
    );
  });
}
```

### Test Template

```typescript
import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/helper.ts";
import { pathname$ } from "../route.ts";
import { screen } from "@testing-library/react";

const context = testContext();

describe("MyPage", () => {
  it("should render the page", async () => {
    server.use(
      http.get("/api/scope", () => {
        return HttpResponse.json({ id: "scope_123", slug: "user-123" });
      }),
    );

    await setupPage({
      context,
      path: "/my-page",
    });

    expect(screen.getByText("Expected Content")).toBeDefined();
    expect(context.store.get(pathname$)).toBe("/my-page");
  });

  it("should handle unauthenticated user", async () => {
    await setupPage({
      context,
      path: "/",
      user: null,
    });

    // Test unauthenticated behavior
  });
});
```

### Key Principles

1. **Mock only `@clerk/clerk-js`**—the external auth package. Never mock internal `auth.ts`.

2. **Use MSW for HTTP mocking**—all API calls are mocked via MSW handlers.

3. **Use `setupPage()` helper**—this mirrors `main.ts` bootstrap flow.

4. **Use `testContext()`**—provides `store` and `signal` with automatic cleanup.

5. **Configure auth per test** via `user` and `session` options.

6. **Override MSW handlers per test** with `server.use()`.

### Signal-Only Tests

For testing signals without rendering React components:

```typescript
import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { testContext } from "./test-helpers.ts";
import { scope$, hasScope$ } from "../scope.ts";

const context = testContext();

describe("scope signals", () => {
  it("hasScope$ returns true when user has scope", async () => {
    const hasScope = await context.store.get(hasScope$);
    expect(hasScope).toBeTruthy();
  });

  it("hasScope$ returns false when no scope (404)", async () => {
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    const hasScope = await context.store.get(hasScope$);
    expect(hasScope).toBeFalsy();
  });
});
```

---

## Standard Test File Structure

Every web route test file should follow this structure:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST, GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

// ========== MOCKS SECTION ==========
// Only mock EXTERNAL third-party packages
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

// ========== TEST CONTEXT ==========
const context = testContext();

// ========== TEST SUITE ==========
describe("POST /api/agent/runs", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const { composeId } = await createTestCompose(`agent-${Date.now()}`);
    testComposeId = composeId;
  });

  // ========== TEST CASES ==========
  it("should create a run with running status", async () => {
    // Given - fixtures prepared in beforeEach

    // When - execute behavior under test
    const data = await createTestRun(testComposeId, "Test prompt");

    // Then - assert the HTTP response
    expect(data.status).toBe("running");
    expect(data.runId).toBeDefined();
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost/api/agent/runs", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });
});
```

Note what's absent compared to older patterns:

- No `vi.clearAllMocks()` — Vitest config has `clearMocks: true`
- No `initServices()` — Route handlers call it internally
- No `afterEach` database cleanup — `setupUser()` provides isolated user context
- No database state assertions — Test HTTP responses only

---

## What to Mock vs What to Use Real

### External Dependencies (MOCK)

**Third-party SaaS/APIs**:

- `@clerk/nextjs` - Authentication service
- `@aws-sdk/client-s3` - Cloud storage
- `@e2b/code-interpreter` - Sandbox service
- `@anthropic-ai/sdk` - AI API
- `@axiomhq/js` - Logging SaaS
- `@stripe/stripe-js` - Payment API

### Internal Implementation (USE REAL)

**Database**:

- `globalThis.services.db` - Always use real database
- Database queries and operations
- Transaction logic

**Internal services**:

- `../../lib/blob/blob-service`
- `../../lib/storage/storage-service`
- `../../lib/run/run-service`
- `../../lib/auth/get-user-id`
- All internal utilities and helpers

**Test data management**:

- Create test data via API helpers (`createTestCompose`, `createTestRun`, etc.)
- `testContext().setupUser()` provides isolated user context with unique IDs
- No manual cleanup needed — user isolation handles it

---

## Migration Workflow

When refactoring an existing test file to follow these patterns, use this workflow:

### Step 1: Identify Mocks

List all `vi.mock()` calls and classify each:

| Mock Type                                  | Action   |
| ------------------------------------------ | -------- |
| External (third-party from node_modules)   | Keep     |
| Internal (relative path `../../` or `../`) | Remove   |
| Built-in (fs, child_process)               | Evaluate |

**Questions to ask**:

- Does this import start with `@` or is it a package name? → Likely external
- Does it use relative path `../../`? → Internal (remove)
- Is it from `node_modules`? → Check if third-party

### Step 2: Remove Internal Mocks

```typescript
// BEFORE
vi.mock("../../lib/run", () => ({
  runService: { createRun: vi.fn() },
}));

// AFTER (remove mock, use API helpers to create fixtures)
import { createTestRun } from "../../../../../src/__tests__/api-test-helpers";
```

### Step 3: Use testContext Pattern

```typescript
const context = testContext();

beforeEach(async () => {
  context.setupMocks();
  user = await context.setupUser();
});

// No vi.clearAllMocks() — Vitest config has clearMocks: true
// No afterEach cleanup — setupUser() provides isolated user context
```

### Step 4: Verify Test Quality

Transform tests from mock verification to behavior verification:

```typescript
// BEFORE: Testing mock calls
expect(mockService.doSomething).toHaveBeenCalled();

// AFTER: Testing actual behavior
const result = await service.doSomething();
expect(result.status).toBe("success");

// Verify with real database
const dbRecord = await globalThis.services.db.select()...
expect(dbRecord).toMatchObject({ status: "success" });
```

### Step 5: Check for Helpers

- Can you use `mockClerk()` helper for Clerk auth?
- Can you share MSW handlers in `mocks/handlers/`?
- Can you extract common test setup into helpers?

```typescript
// BEFORE: Verbose Clerk mock
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
const mockAuth = vi.mocked(auth);
mockAuth.mockResolvedValue({ userId: testUserId });

// AFTER: Use helper
import { mockClerk } from "@/__tests__/clerk-mock";
mockClerk({ userId: testUserId });
```
