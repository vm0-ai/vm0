# Testing Patterns

This document describes our standard testing patterns. These aren't arbitrary conventions—they're the patterns that have proven to work well for our codebase, helping us write tests that give real confidence while remaining maintainable.

## Pattern 1: Route Integration Tests

API endpoints live in `apps/api` and are tested through the Hono app with
`setupApp()` and the route's ts-rest contract. See
[api-testing.md](./api-testing.md) for the full route-test pattern — file
layout, fixtures, mocking rules, and service-level exceptions.

Frontend apps do not host API route handlers or thin proxy route handlers.
Frontend-side tests therefore cover only routing compatibility — exact Vercel
rewrite entries, service-worker handling of API and navigation requests, and
security headers around proxied paths.

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

**Clerk Mock Helper** (`turbo/apps/platform/src/__tests__/mock-auth.ts`):

```typescript
import { clearMockedAuth, mockUser } from "../../../__tests__/mock-auth";

mockUser(
  {
    id: "user_test",
    fullName: "Test User",
    email: "test@example.com",
  },
  { token: "test-token" },
);

clearMockedAuth();
```

**Usage patterns**:

```typescript
import { clearMockedAuth, mockUser } from "../../../__tests__/mock-auth";

beforeEach(() => {
  mockUser(
    {
      id: testUserId,
      fullName: "Test User",
      email: "test@example.com",
    },
    { token: "test-token" },
  );
});

afterEach(() => {
  clearMockedAuth();
});

// Override for specific test
it("should reject unauthenticated request", () => {
  mockUser(null, null);
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

## Pattern 7: Platform Page Tests

`turbo/apps/platform` tests should cover page-visible behavior through the
same bootstrap path the app uses in production. The detailed rules live in
[app-testing.md](./app-testing.md); this section is the short pattern to use
while writing or reviewing platform tests.

Page tests live under `src/views/**/__tests__/` and enter through
`detachedSetupPage`. Configure API, browser, upload, Ably, auth, and test data
mocks through `context.mocks` before page setup so every override is tied to the
same test lifecycle signal.

```typescript
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper";
import { testContext } from "../../../signals/__tests__/test-helpers";

const context = testContext();

describe("items page", () => {
  it("creates an item from the page", async () => {
    const user = userEvent.setup();

    context.mocks.http.get("/api/items", () => {
      return HttpResponse.json({ items: [] });
    });
    context.mocks.http.post("/api/items", async ({ request }) => {
      const body = await request.json();
      return HttpResponse.json({ id: "item_1", ...body }, { status: 201 });
    });

    detachedSetupPage({ context, path: "/items" });

    await user.type(await screen.findByRole("textbox"), "New Item");
    await user.click(await screen.findByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText("New Item")).toBeInTheDocument();
    });
  });
});
```

Key points:

1. **Use `detachedSetupPage()` for view tests**. Do not render platform
   components directly.
2. **Mock through `context.mocks`**. Do not import MSW `server` or call
   `server.use()` from page tests.
3. **Use `setupPage({ withoutRender: true })` only for signal tests** that need
   platform bootstrap without React rendering.
4. **Prefer page tests over signal tests**. Signal-only tests are reserved for
   behavior with no user-visible page surface.
5. **Let `testContext()` own cleanup**. It aborts the test signal and resets
   handlers, local storage state, and logger state after each test.

---

## Standard Test File Structure

Every API route test file should follow this structure:

```typescript
import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";

// ========== TEST CONTEXT ==========
const context = testContext();

function apiClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

// ========== TEST SUITE ==========
describe("POST /api/zero/agents", () => {
  it("creates an agent and returns it from the list endpoint", async () => {
    context.mocks.clerk.session("user_test", "org_test");

    const created = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Support Agent",
          description: "Handles support tasks",
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
      expect.objectContaining({ agentId: created.body.agentId }),
    );
  });

  it("should reject unauthenticated request", async () => {
    const response = await apiClient().create({
      headers: {},
      body: {
        displayName: "Support Agent",
        description: "Handles support tasks",
        sound: "friendly",
      },
    });

    expect(response.status).toBe(401);
  });
});
```

Note what's absent compared to older patterns:

- No ad hoc `vi.clearAllMocks()` — API tests reset centralized mocks from
  `turbo/apps/api/src/__tests__/setup.ts`
- No route handler imports — tests call the real Hono app through `setupApp()`
- No `initServices()` — API app entry points initialize services
- No direct database setup or assertions — create and verify state through API
  behavior

---

## What to Mock vs What to Use Real

### External Dependencies (MOCK)

**Third-party SaaS/APIs**:

- `@clerk/backend` - API authentication service
- `@clerk/clerk-js` / `@clerk/clerk-react` - Platform authentication service
- `@aws-sdk/client-s3` - Cloud storage
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

- Create and verify test data via API calls
- `testContext()` provides isolated route context and centralized mocks
- No manual cleanup needed for API route tests that stay inside the route
  context

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

// AFTER: remove the mock and build state through the API contract client
const created = await accept(
  apiClient().create({ headers: authHeaders(), body: requestBody }),
  [201],
);
```

### Step 3: Use testContext Pattern

```typescript
const context = testContext();

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

it("handles an authenticated request", async () => {
  context.mocks.clerk.session("user_test", "org_test");

  const response = await apiClient().create({
    headers: authHeaders(),
    body: requestBody,
  });

  expect(response.status).toBe(201);
});

// No ad hoc vi.clearAllMocks() — API setup resets centralized mocks
// No direct DB cleanup — route tests should stay inside the route context
```

### Step 4: Verify Test Quality

Transform tests from mock verification to behavior verification:

```typescript
// BEFORE: Testing mock calls
expect(mockService.doSomething).toHaveBeenCalled();

// AFTER: Testing actual behavior
const result = await service.doSomething();
expect(result.status).toBe("success");

// For API route tests, verify persisted effects through a follow-up API call
const listed = await accept(
  apiClient().list({ headers: authHeaders() }),
  [200],
);
expect(listed.body).toContainEqual(expect.objectContaining({ id: result.id }));
```

### Step 5: Check for Helpers

- Can you use `context.mocks.clerk` for API auth or `mockUser()` for platform
  auth?
- Can you share MSW handlers in `mocks/handlers/`?
- Can you extract common test setup into helpers?

```typescript
// BEFORE: Verbose Clerk module mock in a platform test
vi.mock("@clerk/clerk-js", () => ({ Clerk: vi.fn() }));

// AFTER: Use the platform auth helper
import { mockUser } from "../../../__tests__/mock-auth";
mockUser({ id: testUserId, fullName: "Test User" }, { token: "test-token" });
```
