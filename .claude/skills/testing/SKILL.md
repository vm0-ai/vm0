---
name: testing
description: Comprehensive testing patterns and anti-patterns for writing and reviewing tests
context: fork
---

# Testing Skill

## When to Use This Skill

Use this skill when:
- Writing new test files
- Reviewing test code in pull requests
- Refactoring existing tests to improve quality
- Investigating test failures or flaky tests
- Ensuring tests follow project standards

This skill provides:
- Anti-pattern detection and remediation guidance
- Standard patterns for different test types
- Migration workflows for refactoring tests
- Reference implementations and examples

---

## Testing Strategy

We follow Kent C. Dodds' philosophy: **"Write tests. Not too many. Mostly integration."**

```
        ┌─────┐
        │ E2E │           ← Few tests, happy path only
       ┌┴─────┴┐
       │ Integ │          ← Primary tests, full coverage
      ┌┴───────┴┐
      │  Static │         ← TypeScript, ESLint
      └─────────┘
```

### Integration Tests (Primary)

Test at system entry points with external dependencies mocked. These are our **primary tests** covering all scenarios: success, errors, edge cases, variations.

| Type | Entry Point | Mock Boundary | Location |
|------|-------------|---------------|----------|
| **CLI Command Integration Tests** | `command.parseAsync()` | Web API (MSW) | `src/commands/**/__tests__/` |
| **Web Route Integration Tests** | Route handlers (GET/POST) | External services (Clerk, S3, E2B) | `app/api/**/__tests__/` |

**Why integration tests give the best ROI:**
- Exercise all internal code: validators, formatters, domain logic
- Fast: MSW mocks external HTTP, no real network calls
- Reliable: No flaky external dependencies
- Comprehensive: Cover all code paths including error handling

### E2E Tests (Verification)

Happy path only. Verify systems work together end-to-end.

**Why E2E tests are expensive:**
- Each `vm0 run` takes ~15 seconds
- Network issues, API rate limits, external service availability
- Hard to reliably test error conditions

### No Unit Tests

We don't write unit tests. Integration tests at entry points already exercise all internal logic. Testing internal functions separately adds maintenance burden without additional confidence.

### Reference Documentation

| Topic | Reference |
|-------|-----------|
| CLI Command Integration Tests | [cli-testing.md](./reference/cli-testing.md) |
| CLI E2E Tests (BATS) | [cli-e2e-testing.md](./reference/cli-e2e-testing.md) |
| Web Route Integration Tests | [web-testing.md](./reference/web-testing.md) |
| Platform Integration Tests | [platform-testing.md](./reference/platform-testing.md) |

---

## Core Testing Principles

### The Golden Rules

1. **Only Mock External Dependencies**
   - Rule: If it starts with `../../` or `../`, don't mock it
   - Mock third-party packages from `node_modules` only
   - Use real internal services and database

2. **Test Behavior, Not Implementation**
   - Don't test that functions were called (vi.spyOn anti-pattern)
   - Test outcomes and side effects

3. **Match Production Flow**
   - Test initialization should mirror production startup
   - For example, in turbo/apps/platform, use same bootstrap/setup patterns as main.ts
   - Don't shortcut with direct component rendering

4. **Use Real Infrastructure**
   - Real database connections (initServices())
   - Real filesystem with temp directories
   - Real HTTP with MSW (not fetch mocks)

5. **Fail Fast, No Fallbacks**
   - Don't hide errors with try/catch
   - Don't use fallback values
   - Let errors propagate naturally

6. **Zero Tolerance**
   - No `any` types
   - No lint suppressions
   - No fake timers
   - No mocking internal code

### The Relative Path Rule

The simplest way to detect AP-4 violations (mocking internal code):

```typescript
// ✅ GOOD: Third-party package from node_modules
vi.mock("@clerk/nextjs")
vi.mock("@aws-sdk/client-s3")
vi.mock("@e2b/code-interpreter")
vi.mock("@anthropic-ai/sdk")

// ❌ BAD: Project internal code with relative path
vi.mock("../../blob/blob-service")        // Internal service!
vi.mock("../../storage/storage-service")  // Internal service!
vi.mock("../agent-session-service")       // Internal service!
```

**If you see `../../` or `../` in a vi.mock() call, it's almost always wrong.**

### Mock Hierarchy

What to mock (from external to internal):

```
External (MOCK):
├── Third-party SaaS (Clerk, E2B, AWS, Anthropic)
└── Node.js built-ins (fs, child_process)

Internal (USE REAL):
├── Database (globalThis.services.db)
├── Internal services (../../lib/*)
├── Internal utilities (../../utils/*)
└── Internal modules (../*.ts)
```

---

## Anti-Patterns (Critical Issues)

### AP-1: Testing Mock Calls Instead of Behavior

**Detection**: Tests that verify `toHaveBeenCalled()` on mocks without verifying actual outcomes.

**Why harmful**:
- Tests pass when mocks are called, even if real behavior is broken
- Creates false confidence
- Doesn't catch actual bugs

**BEFORE (❌ Wrong):**
```typescript
it("should call getUser", async () => {
  await someFunction();
  expect(mockGetUser).toHaveBeenCalled();
});
```

**AFTER (✅ Correct):**
```typescript
it("should retrieve and display user data", async () => {
  const result = await someFunction();
  expect(result.userName).toBe("expected-name");
  expect(result.email).toBe("user@example.com");
});
```

---

### AP-2: Direct Fetch Mocking

**Detection**: `vi.fn()` or `vi.stubGlobal()` on `fetch`, `window.fetch`, or `global.fetch`

**PROHIBITION**: Direct fetch mocking is not allowed. Always use MSW.

**Why harmful**:
- Doesn't accurately represent real HTTP behavior
- Doesn't test request/response serialization
- Makes tests brittle and tied to implementation details
- Misses request URL construction bugs
- Doesn't verify request headers, body formatting, or HTTP methods

**BEFORE (❌ Wrong):**
```typescript
// ❌ Bad: Direct fetch mocking
const mockFetch = vi.fn().mockResolvedValue(new Response());
vi.stubGlobal("fetch", mockFetch);

// ❌ Bad: window.fetch assignment
window.fetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ data: "test" }),
});

// ❌ Bad: vi.spyOn on global fetch
vi.spyOn(global, "fetch").mockResolvedValue(
  new Response(JSON.stringify({ data: "test" }))
);
```

**AFTER (✅ Correct):**
```typescript
// ✅ Good: Use MSW for HTTP mocking
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const server = setupServer(
  http.get('https://api.example.com/users', () => {
    return HttpResponse.json({ users: [{ id: 1, name: 'Test' }] });
  }),

  http.post('https://api.example.com/users', async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({ id: 2, ...body }, { status: 201 });
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it('should fetch users from API', async () => {
  const users = await fetchUsers();
  expect(users).toHaveLength(1);
  expect(users[0].name).toBe('Test');
});
```

**Benefits of MSW**:
- Realistic HTTP behavior (status codes, headers, streaming)
- Tests actual request construction (URL, headers, body)
- Declarative API handlers (easier to read and maintain)
- Works in both Node.js tests and browser
- Catches request formatting bugs
- Better error simulation (network errors, timeouts)

**Exception**: For platform signal tests (fetch.test.ts), direct fetch mocking is acceptable when testing the fetch wrapper itself.

**Related commits**: #1419 (58719dcf), #1372 (fa9dcabb)

---

### AP-3: Filesystem Mocking

**Detection**: `vi.mock("fs")` or `vi.mock("fs/promises")`

**PROHIBITION**: Filesystem mocking is not allowed. Use real filesystem with temp directories.

**Why harmful**:
- Tests mock behavior, not actual file operations
- Misses file permission issues, race conditions, edge cases
- Doesn't test actual file writing, atomic operations
- False confidence in file I/O logic

**BEFORE (❌ Wrong):**
```typescript
vi.mock("fs");
vi.mock("fs/promises");

it("should write file", () => {
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);

  registry.register("172.16.0.2", "run-123", "token-abc");

  // Only tests that mock was called, not actual file writing
  expect(mockWriteFileSync).toHaveBeenCalled();
});
```

**AFTER (✅ Correct):**
```typescript
import { mkdirSync, rmSync, readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tempDir: string;

beforeEach(() => {
  // Create real temp directory
  tempDir = mkdtempSync(join(tmpdir(), "test-"));
});

afterEach(() => {
  // Clean up real temp directory
  rmSync(tempDir, { recursive: true, force: true });
});

it("should write file", () => {
  const testPath = join(tempDir, "registry.json");
  const registry = new VMRegistry(testPath);

  registry.register("172.16.0.2", "run-123", "token-abc");

  // Verify actual file was written
  const content = JSON.parse(readFileSync(testPath, "utf-8"));
  expect(content.vms["172.16.0.2"]).toMatchObject({
    runId: "run-123",
    sandboxToken: "token-abc",
  });
});
```

**Migrated files (8 total)**:
1. `apps/cli/src/commands/__tests__/init.test.ts`
2. `apps/cli/src/commands/__tests__/compose.test.ts`
3. `apps/cli/src/commands/__tests__/cook.test.ts`
4. `apps/runner/src/lib/proxy/__tests__/vm-registry.test.ts`
5. `apps/runner/src/__tests__/config.test.ts`
6. `apps/cli/src/commands/schedule/__tests__/init.test.ts`
7. `apps/cli/src/lib/domain/__tests__/cook-state.test.ts`
8. `apps/runner/src/lib/proxy/__tests__/proxy-manager.test.ts`

**Remaining exception**: `ip-pool.test.ts` (requires code refactoring to accept configurable paths)

**Related commit**: #1420 (889765f1)

---

### AP-4: Mocking Internal Code (HIGHEST PRIORITY)

**Detection**: Any `vi.mock()` with relative path (`../../` or `../`)

**PROHIBITION**: Mocking internal application code is not allowed.

Based on systematic review of 70+ test files, tests should **only mock third-party packages from node_modules**, not project internal code.

**Why harmful**:
- Hides bugs in the actual code path
- Creates false confidence (test passes but production fails)
- Makes refactoring harder (tests depend on implementation details)
- Reduces test value (you're not testing real behavior)
- Breaks integration testing (mocks bypass actual logic)
- Tests verify mock orchestration, not real API behavior
- Misses real integration bugs (database, auth, services)

**What Counts as AP-4 Violation**:

❌ **Mocking project database**:
- `globalThis.services.db` (project PostgreSQL database)
- Database query methods (select, insert, update, delete)

❌ **Mocking project internal services**:
- `../../blob/blob-service` (internal service)
- `../../agent-session/agent-session-service` (internal service)
- `../../storage/storage-service` (internal service)
- `../../run/run-service` (internal service)
- `../../e2b/e2b-service` (internal service)
- `../../lib/auth/get-user-id` (internal auth utility)
- `../../lib/axiom` (internal logging service)
- Any relative import path `../../*` or `../*`

❌ **Mocking project infrastructure**:
- File system operations (use real file system or temp directories)
- Environment variables (use vi.stubEnv)
- Internal utilities and helpers

**What is Acceptable to Mock**:

✅ **Third-party external services (from node_modules)**:
- `@clerk/nextjs` - Authentication SaaS
- `@aws-sdk/client-s3` - AWS cloud storage
- `@e2b/code-interpreter` - Sandbox SaaS
- `@anthropic-ai/sdk` - AI API
- `@axiomhq/js` - Logging SaaS (external service)
- Other third-party packages that require API keys or external infrastructure

✅ **Node.js built-ins** (sparingly):
- `child_process` - Process spawning
- Other Node.js core modules (except `fs` - see AP-3)

**BEFORE (❌ Wrong):**
```typescript
// ❌ Mock internal get-user-id utility
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

// ❌ Mock internal run service
vi.mock("../../../../src/lib/run", () => ({
  runService: {
    buildExecutionContext: vi.fn().mockResolvedValue({}),
    prepareAndDispatch: vi.fn().mockResolvedValue({ status: "pending" }),
  },
}));

// ❌ Mock project database
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
};

beforeEach(() => {
  globalThis.services.db = mockDb;
});
```

**AFTER (✅ Correct):**
```typescript
// ✅ Only mock external Clerk auth (third-party SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";
const mockAuth = vi.mocked(auth);

beforeAll(() => {
  initServices(); // Use real database
});

beforeEach(() => {
  // Mock only external auth
  mockAuth.mockResolvedValue({
    userId: testUserId,
  } as unknown as Awaited<ReturnType<typeof auth>>);

  // Use real getUserId() service (no mock!)
  // Use real runService (no mock!)
});

it("should create a run with real service integration", async () => {
  const response = await POST(request);

  // Verify run was created in real database
  const run = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, data.id));

  expect(run).toHaveLength(1);
  expect(run[0]!.status).toBe("pending");
});
```

**Key Points**:
- **Only mock third-party packages**: `@clerk/nextjs/server`, `@aws-sdk/client-s3`, `@e2b/code-interpreter`
- **Never mock internal code**: No `../../../../src/lib/*` mocks
- **Use real database**: Call `initServices()` to get real DB connection
- **Clean up test data**: Delete in `beforeEach`/`afterAll` using real DB operations

**Summary Table**:

| What | Mock? | Why |
|------|-------|-----|
| `@clerk/nextjs` | ✅ Yes | Third-party SaaS, requires API key |
| `@aws-sdk/client-s3` | ✅ Yes | Third-party cloud, requires credentials |
| `@e2b/code-interpreter` | ✅ Yes | Third-party SaaS, requires API key |
| `@anthropic-ai/sdk` | ✅ Yes | Third-party API, requires API key |
| `child_process` | ✅ Yes | Node.js built-in for process spawning |
| `fs` | ❌ No | Use real filesystem with temp directories (AP-3) |
| `globalThis.services.db` | ❌ No | Project database, use real connection |
| `../../blob/blob-service` | ❌ No | Internal service, use real implementation |
| `../../storage/*` | ❌ No | Internal service, use real implementation |
| `../../agent-session/*` | ❌ No | Internal service, use real implementation |
| `../../run/*` | ❌ No | Internal service, use real implementation |
| `../storage-resolver` | ❌ No | Internal utility, use real implementation |

---

### AP-5: Fake Timers (vi.useFakeTimers)

**Detection**: `vi.useFakeTimers()`, `vi.advanceTimersByTime()`, `vi.setSystemTime()`

**PROHIBITION**: Fake timers mask real timing issues and are not allowed.

**Why harmful**:
- Mask real timing issues and race conditions
- Don't test actual async behavior
- Hide bugs that only appear with real timers
- Make tests less realistic

**BEFORE (❌ Wrong):**
```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

it("should use fixed time", () => {
  const timestamp = Date.now();
  expect(timestamp).toBe(new Date("2024-01-15T12:00:00Z").getTime());
});
```

**AFTER (✅ Correct):**
```typescript
beforeEach(() => {
  // Mock Date.now specifically, not all timers
  vi.spyOn(Date, 'now').mockReturnValue(
    new Date("2024-01-15T12:00:00Z").getTime()
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("should use fixed timestamp", () => {
  const timestamp = Date.now();
  expect(timestamp).toBe(new Date("2024-01-15T12:00:00Z").getTime());
});
```

**Rationale**:
- Fake timers mask real timing issues
- More specific mocking (only Date.now, not all timers)
- Tests handle real async behavior
- Catches actual race conditions

**Related commit**: #1415 (29c16a60)

---

### AP-6: Partial Internal Mocks (vi.importActual)

**Detection**: `vi.importActual()` used to partially mock internal modules

**Why harmful**:
- Partial mocks are confusing and brittle
- Internal modules should use real implementation
- Tests that need partial mocking usually indicate design issues

**BEFORE (❌ Wrong):**
```typescript
vi.mock("@vm0/core", async () => {
  const actual = await vi.importActual("@vm0/core");
  return {
    ...actual,
    extractVariableReferences: vi.fn(),
    groupVariablesBySource: vi.fn(),
  };
});
```

**AFTER (✅ Correct):**
```typescript
// Use real @vm0/core implementation
// Test the actual extractRequiredVarNames function
import { extractRequiredVarNames } from "../cook";

it("should extract and combine vars and secrets", () => {
  const config = {
    vars: { VAR1: "value" },
    secrets: { SECRET1: "value" },
  };

  const result = extractRequiredVarNames(config);
  expect(result).toEqual(["VAR1", "SECRET1"]);
});
```

---

### AP-7: Testing Implementation Details

**Detection**: Tests that verify internal function calls, keyboard handlers, CSS classes, or React state

**Why harmful**:
- Makes tests brittle (break on refactoring)
- Doesn't test user-visible behavior
- Couples tests to implementation

**BEFORE (❌ Wrong):**
```typescript
// ❌ Bad: Testing keyboard handlers
it("should prevent form submission on Shift+Enter", () => {
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(mockSubmit).not.toHaveBeenCalled();
});

// ❌ Bad: Testing CSS classes
it("should have correct CSS classes", () => {
  expect(button).toHaveClass("btn-primary");
});

// ❌ Bad: Testing internal state
it("should update state correctly", () => {
  expect(component.state.count).toBe(1);
});
```

**AFTER (✅ Correct):**
```typescript
// ✅ Good: Test user-visible behavior
it("should submit form when user presses send button", () => {
  userEvent.click(sendButton);
  expect(screen.getByText("Message sent")).toBeInTheDocument();
});

// ✅ Good: Test visual output
it("should display button as primary style", () => {
  expect(button).toBeVisible();
  expect(button).toBeEnabled();
});

// ✅ Good: Test outcome, not state
it("should increment counter when clicked", () => {
  userEvent.click(button);
  expect(screen.getByText("Count: 1")).toBeInTheDocument();
});
```

---

### AP-8: Over-Testing

**Detection**: Tests for trivial rendering, every HTTP status code, or schema validation

**Patterns to avoid**:

**Over-testing error responses**:
```typescript
// ❌ Bad: Testing every error status
it("should return 401 when not authenticated", async () => {
  expect(response.status).toBe(401);
});
it("should return 404 when not found", async () => {
  expect(response.status).toBe(404);
});
it("should return 400 when invalid", async () => {
  expect(response.status).toBe(400);
});

// ✅ Good: Test meaningful error behavior
it("should handle authentication flow correctly", async () => {
  // Test the actual authentication logic and business rules
});
```

**Over-testing schema validation**:
```typescript
// ❌ Bad: Testing that Zod works
it("should validate required fields", () => {
  expect(() => schema.parse({})).toThrow();
});

// ✅ Good: Trust Zod, test business logic
it("should process valid user data", () => {
  const result = processUser(validData);
  expect(result.role).toBe("member");
});
```

**Over-testing trivial rendering**:
```typescript
// ❌ Bad: Testing conditional rendering
it("should show loading spinner when loading", () => {
  render(<Component isLoading={true} />);
  expect(screen.getByTestId("spinner")).toBeInTheDocument();
});

// ✅ Good: Test the logic that produces states
it("should load data and handle errors", async () => {
  render(<Component />);
  await waitFor(() => {
    expect(screen.getByText("Loaded data")).toBeInTheDocument();
  });
});
```

**Over-testing UI text content**:
```typescript
// ❌ Bad: Testing exact text
it("should display correct heading", () => {
  expect(screen.getByRole("heading")).toHaveTextContent("Welcome to Dashboard");
});

// ✅ Good: Test functionality
it("should allow user to create new project", async () => {
  await userEvent.click(screen.getByTestId("create-project-button"));
  expect(screen.getByTestId("project-form")).toBeVisible();
});
```

---

### AP-9: Console Mocking Without Assertions

**Detection**: Mocking `console.log` or `console.error` without verifying output

**Why harmful**:
- Adds no value (just suppresses output)
- Doesn't verify logging behavior
- Makes tests less informative

**BEFORE (❌ Wrong):**
```typescript
beforeEach(() => {
  console.log = vi.fn();
  console.error = vi.fn();
});

it("should do something", () => {
  // Test code that logs, but no assertions on logs
});
```

**AFTER (✅ Correct):**
```typescript
// Option 1: Assert on logs
it("should log error details", () => {
  const consoleSpy = vi.spyOn(console, "error");
  performAction();
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("error"));
});

// Option 2: Don't mock (let output appear)
it("should do something", () => {
  // Natural console output in tests is fine
});
```

---

### AP-10: Direct Component Rendering

**Detection**: Direct `render(<StoreProvider><Component /></StoreProvider>)` in platform tests

**PROHIBITION**: Component tests should follow production initialization flow.

**Why harmful**:
- Tests don't match production initialization
- Misses setup commands and bootstrap logic
- Can't catch initialization bugs
- Inconsistent with real application flow

**BEFORE (❌ Wrong):**
```typescript
it("should render the page", () => {
  const store = createStore();

  render(
    <StoreProvider value={store}>
      <MyPage />
    </StoreProvider>
  );

  expect(screen.getByText("Title")).toBeInTheDocument();
});
```

**AFTER (✅ Correct):**
```typescript
import { bootstrap$ } from "../../../signals/bootstrap.ts";
import { navigate$ } from "../../../signals/route.ts";
import { page$ } from "../../../signals/react-router.ts";
import { setupRouter } from "../../main.tsx";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

it("should render the page", async () => {
  const { store, signal } = context;

  // Render the router (like main.ts does)
  const { container } = render(<div id="test-root" />);
  const rootEl = container.querySelector("#test-root") as HTMLDivElement;

  // Bootstrap the app (like main.ts does)
  await store.set(
    bootstrap$,
    () => {
      setupRouter(store, (element) => {
        render(element, { container: rootEl });
      });
    },
    signal,
  );

  // Navigate to the page (this triggers setupMyPage$ automatically)
  await store.set(navigate$, "/my-page", {}, signal);

  // Verify page was rendered
  const pageElement = store.get(page$);
  expect(pageElement).toBeDefined();
});
```

**Key points**:
1. Use `bootstrap$` to initialize the app
2. Use `navigate$` to trigger page setup
3. Use `setupRouter` to establish same rendering context as main.ts
4. Use `testContext()` for proper cleanup
5. Follow bootstrap → route → setup → render flow

---

## Testing Patterns by Type

### Pattern 1: API Route Tests

**When to use**: Testing Next.js API route handlers in `app/api/**/route.ts`

**Standard template**:

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initServices } from "../../../../src/lib/init-services";

// ========== MOCKS SECTION ==========
// Only mock EXTERNAL third-party packages

// Mock external Clerk auth (third-party SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// ========== IMPORTS SECTION ==========
import { auth } from "@clerk/nextjs/server";
// Import real internal services (NO MOCKS!)
import { POST } from "./route";
import { agentRuns } from "../../../../src/lib/db/schema";
import { eq } from "drizzle-orm";

const mockAuth = vi.mocked(auth);

// ========== TEST SUITE ==========
describe("POST /api/agent/runs", () => {
  const testUserId = "test-user-123";

  beforeAll(() => {
    // Initialize real database connection
    initServices();
  });

  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();

    // Configure external mocks
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as Awaited<ReturnType<typeof auth>>);
  });

  afterEach(async () => {
    // Clean up test data in real database
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));
  });

  it("should create run with real service integration", async () => {
    const request = new Request("http://localhost/api/agent/runs", {
      method: "POST",
      body: JSON.stringify({ name: "Test Run" }),
    });

    // Test with real services and real database
    const response = await POST(request);
    const data = await response.json();

    // Verify with real database query
    const dbRuns = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, data.id));

    expect(dbRuns).toHaveLength(1);
    expect(dbRuns[0]!.status).toBe("pending");
  });
});
```

**Variations**:

**Webhook endpoints** (double auth setup):
```typescript
beforeEach(() => {
  // First call: Check CLI token (returns null)
  // Second call: Check Clerk auth
  mockAuth
    .mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>)
    .mockResolvedValueOnce({ userId: testUserId } as Awaited<ReturnType<typeof auth>>);
});
```

**Multi-user scenarios**:
```typescript
afterEach(async () => {
  // Clean up all test users
  await globalThis.services.db
    .delete(agentRuns)
    .where(inArray(agentRuns.userId, [testUserId1, testUserId2]));
});
```

---

### Pattern 2: Pure Function Tests (Rare Exception)

**When to use**: Only for **security-critical** or **extremely complex algorithmic** pure functions. This is a rare exception - avoid unit tests whenever possible.

**Allowed cases**:
- Security-critical functions (cryptographic operations, token validation, permission checks)
- Extremely complex algorithms where bugs would have severe consequences

**NOT allowed** (test via integration tests instead):
- Validators, parsers, formatters
- Simple utility functions
- Any function that can be exercised through route/command integration tests

**Note**: Default to integration tests. Only create unit tests when there's a strong security or complexity justification.

**Template**:

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

// NO mocks needed for pure functions!
// NO beforeEach/afterEach needed if no state!
// Focus on behavior and edge cases
```

---

### Pattern 3: MSW HTTP Mocking

**When to use**: Mocking external HTTP APIs in tests

**Handler setup**:

```typescript
// mocks/handlers/api-handlers.ts
import { http, HttpResponse } from "msw";

export const apiHandlers = [
  // GET with params
  http.get("https://api.example.com/users/:id", ({ params }) => {
    const { id } = params;
    return HttpResponse.json(
      { id, name: "Test User" },
      { status: 200 }
    );
  }),

  // POST with request body
  http.post("https://api.example.com/users", async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json(
      { id: "new-id", ...body },
      { status: 201 }
    );
  }),

  // Error simulation
  http.get("https://api.example.com/error", () => {
    return HttpResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
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
import { setupServer } from 'msw/node';
import { apiHandlers } from './mocks/handlers/api-handlers';

const server = setupServer(...apiHandlers);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("should fetch user data", async () => {
  // MSW automatically intercepts fetch calls
  const user = await fetchUser("123");
  expect(user.name).toBe("Test User");
});

it("should handle API errors", async () => {
  // Override handler for specific test
  server.use(
    http.get("https://api.example.com/users/:id", () => {
      return HttpResponse.json({ error: "Not found" }, { status: 404 });
    })
  );

  await expect(fetchUser("999")).rejects.toThrow("Not found");
});
```

**Benefits**:
- Realistic HTTP behavior
- Tests actual request construction
- Works in both Node.js and browser

---

### Pattern 4: Real Filesystem Testing

**When to use**: Testing code that reads/writes files

**Template**:

```typescript
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tempDir: string;

beforeEach(() => {
  // Create real temp directory
  tempDir = mkdtempSync(join(tmpdir(), "test-"));
});

afterEach(() => {
  // Clean up real temp directory
  rmSync(tempDir, { recursive: true, force: true });
});

it("should write config file", () => {
  const configPath = join(tempDir, "config.json");

  // Use real file operations
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

**Exception**: `ip-pool.test.ts` still uses fs mocks due to hardcoded paths in production code. Requires refactoring to accept configurable paths.

**Related commit**: #1420 (889765f1)

---

### Pattern 5: Mock Helpers (Reusable Utilities)

**When to use**: Common mock patterns used across multiple test files

**Example: Clerk Mock Helper**

**File**: `turbo/apps/web/src/__tests__/clerk-mock.ts`

```typescript
import { vi } from "vitest";
import { auth } from "@clerk/nextjs/server";

const mockAuth = vi.mocked(auth);

/**
 * Configure Clerk auth mock
 */
export function mockClerk(options: { userId: string | null }) {
  mockAuth.mockResolvedValue({
    userId: options.userId,
  } as Awaited<ReturnType<typeof auth>>);
}

/**
 * Clear all Clerk mock calls
 */
export function clearClerkMock() {
  mockAuth.mockClear();
}
```

**Usage patterns**:

**Standard pattern**:
```typescript
import { mockClerk, clearClerkMock } from '@/__tests__/clerk-mock';

beforeEach(() => {
  mockClerk({ userId: testUserId });
});

afterEach(() => {
  clearClerkMock();
});
```

**Once pattern** (for tests that need different auth states):
```typescript
beforeEach(() => {
  mockClerk({ userId: testUserId });
});

it("should reject unauthenticated request", () => {
  mockClerk({ userId: null }); // Override for this test
  // ... test code
});
```

**Double-set pattern** (for webhook endpoints):
```typescript
beforeEach(() => {
  // First call: CLI token check (returns null)
  mockClerk({ userId: null });
  // Second call: Clerk auth check
  mockClerk({ userId: testUserId });
});
```

---

### Pattern 6: Environment Variable Stubbing

**When to use**: Tests that need to set environment variables

**Template**:

```typescript
beforeEach(() => {
  // Stub environment variables
  vi.stubEnv("API_KEY", "test-key");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://test");
});

afterEach(() => {
  // Clean up all stubbed env vars
  vi.unstubAllEnvs();
});

it("should use environment variable", () => {
  expect(process.env.API_KEY).toBe("test-key");

  const config = loadConfig();
  expect(config.apiKey).toBe("test-key");
});
```

**Anti-pattern** (manual save/restore):
```typescript
// ❌ Bad: Manual save/restore
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

**Benefits**:
- Proper cleanup (no env pollution between tests)
- Less boilerplate code
- More reliable test isolation

**Files updated (4)**:
- `config.test.ts`
- `cook.test.ts`
- `logger.test.ts`
- `auth.test.ts`

**Related commit**: #1414 (7f0b0924)

---

### Pattern 7: Platform Component Tests (apps/platform)

**When to use**: Testing React components and signals in the platform app (`apps/platform`)

The platform uses **ccstate** for state management and requires tests to follow the production initialization flow. This pattern uses centralized test helpers that mirror `main.ts` startup.

#### Test Infrastructure Files

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

// Mock @clerk/clerk-js globally (only external dependency)
vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return mockedClerk;
  },
}));

// Start MSW server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

// Reset handlers after each test
afterEach(() => server.resetHandlers());

// Close server after all tests
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

  // Bootstrap the app (like main.ts does)
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

#### Test Template

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
    // Setup MSW handlers for this test (optional)
    server.use(
      http.get("/api/scope", () => {
        return HttpResponse.json({ id: "scope_123", slug: "user-123" });
      }),
    );

    // Bootstrap app and navigate to path
    await setupPage({
      context,
      path: "/my-page",
    });

    // Verify page was rendered
    expect(screen.getByText("Expected Content")).toBeDefined();
    expect(context.store.get(pathname$)).toBe("/my-page");
  });

  it("should redirect when user has no scope", async () => {
    // Override handler to return 404
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    await setupPage({
      context,
      path: "/protected-page",
    });

    // Verify redirect occurred
    expect(context.store.get(pathname$)).toBe("/");
  });

  it("should handle unauthenticated user", async () => {
    await setupPage({
      context,
      path: "/",
      user: null, // No user logged in
    });

    // Test unauthenticated behavior
  });
});
```

#### Key Principles

1. **Mock only `@clerk/clerk-js`** - This is the external auth package. Never mock internal `auth.ts` or other internal modules.

2. **Use MSW for HTTP mocking** - All API calls (`/api/scope`, etc.) are mocked via MSW handlers, not direct fetch mocking.

3. **Use `setupPage()` helper** - This mirrors `main.ts` bootstrap flow:
   - Sets pathname via `setPathname()`
   - Configures auth via `mockUser()`
   - Bootstraps app via `bootstrap$`
   - Renders via `setupRouter()`

4. **Use `testContext()`** - Provides `store` and `signal` with automatic cleanup between tests.

5. **Configure auth per test** - Use `user` and `session` options in `setupPage()`:
   ```typescript
   // Default: authenticated user
   await setupPage({ context, path: "/" });

   // Unauthenticated
   await setupPage({ context, path: "/", user: null });

   // Custom user
   await setupPage({
     context,
     path: "/",
     user: { id: "custom-id", fullName: "Custom User" },
   });
   ```

6. **Override MSW handlers per test** - Use `server.use()` to customize API responses:
   ```typescript
   server.use(
     http.get("/api/scope", () => {
       return new HttpResponse(null, { status: 404 });
     }),
   );
   ```

#### Anti-patterns

```typescript
// ❌ Bad: Mocking internal auth.ts
vi.mock("../auth.ts", () => ({
  user$: computed(() => mockUser),
}));

// ❌ Bad: Direct component rendering
render(
  <StoreProvider value={store}>
    <MyPage />
  </StoreProvider>
);

// ❌ Bad: Direct fetch mocking
vi.stubGlobal("fetch", vi.fn());

// ❌ Bad: Manual Clerk mock in each test file
vi.mock("@clerk/clerk-js", () => ({ ... }));
```

#### Signal-Only Tests

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
    // Default MSW handler returns a scope
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

All test files should follow this structure:

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";

// ========== MOCKS SECTION ==========
// Place ALL vi.mock() calls at the top, before any imports
// Only mock EXTERNAL third-party packages

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// ========== IMPORTS SECTION ==========
// Import mocked modules first
import { auth } from "@clerk/nextjs/server";

// Import test utilities
import { initServices } from "../../../../src/lib/init-services";

// Import module under test (use REAL implementation)
import { POST } from "./route";

// Import database schema for cleanup
import { agentRuns } from "../../../../src/lib/db/schema";
import { eq } from "drizzle-orm";

// Get typed mock references
const mockAuth = vi.mocked(auth);

// ========== TEST SUITE ==========
describe("Module Name", () => {
  // Test data constants
  const testUserId = "test-user-123";
  const testRunId = "test-run-456";

  beforeAll(() => {
    // One-time setup
    // Initialize real database connection
    initServices();
  });

  beforeEach(() => {
    // Per-test setup
    // REQUIRED: Clear all mocks
    vi.clearAllMocks();

    // Configure external mocks
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as Awaited<ReturnType<typeof auth>>);

    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);
  });

  afterEach(async () => {
    // Per-test cleanup
    // Clean up test data in real database
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));
  });

  afterAll(async () => {
    // One-time cleanup (if needed)
  });

  // ========== TEST CASES ==========
  it("should test real behavior", async () => {
    // Arrange
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
    });

    // Act
    const response = await POST(request);
    const data = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(data.name).toBe("Test");

    // Verify with real database
    const dbData = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, data.id));

    expect(dbData).toHaveLength(1);
  });
});
```

**Key requirements**:
1. All `vi.mock()` calls at the top (before imports)
2. `vi.clearAllMocks()` in `beforeEach` (REQUIRED)
3. Only mock external dependencies
4. Use `initServices()` for real database
5. Clean up test data in `afterEach`
6. Use real implementations for internal code

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
- `../../lib/blob/blob-service` - Use real implementation
- `../../lib/storage/storage-service` - Use real implementation
- `../../lib/run/run-service` - Use real implementation
- `../../lib/auth/get-user-id` - Use real implementation
- All internal utilities and helpers

**Test data management**:
- Create test data with real database operations
- Clean up test data in `beforeEach`/`afterEach`
- Use unique test IDs or prefixes

---

## References

### Web Testing (`/testing web`)

For web app testing patterns specific to `turbo/apps/web`, see:
- [Web Testing Patterns](./reference/web-testing.md)

Key topics:
- Web Route Integration Tests only (no service-level tests)
- `testContext()` and `setupUser()` for user isolation
- API test helpers (`createTestCompose`, `createTestRun`, etc.)
- State transitions via webhook helpers
- No manual cleanup needed

### CLI Testing (`/testing cli`)

For CLI app testing patterns specific to `turbo/apps/cli`, see:
- [CLI Testing Patterns](./reference/cli-testing.md)

Key topics:
- CLI Command Integration Tests via `command.parseAsync()`
- MSW for Web API mocking (external boundary)
- `vi.stubEnv()` for config (not mocking config module)
- Real filesystem with temp directories
- Console output and exit codes as valid assertions

### CLI E2E Testing (`/testing cli-e2e`)

For CLI E2E testing with BATS, see:
- [CLI E2E Testing Patterns](./reference/cli-e2e-testing.md)

Key topics:
- Happy path only (error cases → CLI Command Integration Tests)
- BATS parallelization model (`-j 10 --no-parallelize-within-files`)
- State sharing via `$BATS_FILE_TMPDIR`
- `setup_file()` for expensive one-time setup
- Max ONE `vm0 run` per test case (timeout safety)

### Platform Testing (`/testing platform`)

For platform app testing patterns specific to `turbo/apps/platform`, see:
- [Platform Testing Patterns](./reference/platform-testing.md)

Key topics:
- UI tests (`.test.tsx` in `views/`) and State tests (`.test.ts` in `signals/`)
- `testContext()` and `setupPage()` for test isolation
- MSW handlers for API mocking (no external network requests allowed)
- Handler patterns: static, stateful with reset, request inspection
- `server.use()` for per-test handler overrides

---

## Quick Anti-Pattern Checklist

Use this checklist when reviewing test code:

**Mocking Issues**:
- [ ] ❌ Mocking internal services (`../../lib/*`)
- [ ] ❌ Mocking `globalThis.services.db`
- [ ] ❌ Direct fetch mocking (use MSW instead)
- [ ] ❌ Filesystem mocking (use temp directories)
- [ ] ❌ Partial mocks with `vi.importActual()`

**Timer Issues**:
- [ ] ❌ Using `vi.useFakeTimers()`
- [ ] ❌ Using `vi.advanceTimersByTime()`
- [ ] ❌ Artificial delays (`setTimeout` in tests)

**Test Quality Issues**:
- [ ] ❌ Testing that mocks were called (not behavior)
- [ ] ❌ Testing UI text content or CSS classes
- [ ] ❌ Testing empty/loading states without logic
- [ ] ❌ Over-testing error status codes
- [ ] ❌ Over-testing schema validation
- [ ] ❌ Direct component rendering (use bootstrap$)

**Code Quality Issues**:
- [ ] ❌ Suppression comments (`@ts-ignore`, `eslint-disable`)
- [ ] ❌ Using `any` type
- [ ] ❌ Dynamic imports (`await import()`)
- [ ] ❌ Hardcoded URLs or configuration
- [ ] ❌ Fallback patterns (should fail fast)

**Required Practices**:
- [ ] ✅ `vi.clearAllMocks()` in `beforeEach`
- [ ] ✅ `initServices()` in `beforeAll` (for database tests)
- [ ] ✅ Database cleanup in `afterEach`
- [ ] ✅ Only mock third-party dependencies
- [ ] ✅ Test real behavior and outcomes

---

## Migration Workflow

Use this workflow when refactoring an existing test file:

### Step 1: Identify Mocks

**Tasks**:
- [ ] List all `vi.mock()` calls in the file
- [ ] Classify each mock:
  - External (third-party from node_modules) → KEEP
  - Internal (relative path `../../` or `../`) → REMOVE
  - Built-in (fs, child_process) → EVALUATE

**Questions to ask**:
- Does this import start with `@` or is it a package name? → Likely external
- Does it use relative path `../../`? → Internal (remove)
- Is it from `node_modules`? → Check if third-party

---

### Step 2: Remove Internal Mocks

**Tasks**:
- [ ] Delete `vi.mock()` for internal services
- [ ] Delete mock implementations (mock functions, objects)
- [ ] Import real implementations instead
- [ ] Add `initServices()` if using database

**Example transformation**:
```typescript
// BEFORE
vi.mock("../../lib/run", () => ({
  runService: {
    createRun: vi.fn(),
  },
}));

// AFTER (remove mock, import real)
import { runService } from "../../lib/run";

beforeAll(() => {
  initServices(); // If using database
});
```

---

### Step 3: Add Proper Cleanup

**Tasks**:
- [ ] Add `vi.clearAllMocks()` to `beforeEach` (REQUIRED)
- [ ] Replace manual env save/restore with `vi.stubEnv()`
- [ ] Add database cleanup in `beforeEach` or `afterEach`
- [ ] Add `vi.unstubAllEnvs()` in `afterEach`

**Example**:
```typescript
beforeEach(() => {
  vi.clearAllMocks(); // REQUIRED

  // Stub environment variables
  vi.stubEnv("API_KEY", "test-key");

  // Configure external mocks
  mockAuth.mockResolvedValue({ userId: testUserId });
});

afterEach(async () => {
  // Clean up environment
  vi.unstubAllEnvs();

  // Clean up database
  await globalThis.services.db
    .delete(testTable)
    .where(eq(testTable.userId, testUserId));
});
```

---

### Step 4: Verify Test Quality

**Tasks**:
- [ ] Tests verify behavior, not mock calls
  - Replace `expect(mockFn).toHaveBeenCalled()` with actual outcome checks
- [ ] Tests use real database queries for verification
  - Add database queries to verify state
- [ ] No fake timers or artificial delays
  - Replace `vi.useFakeTimers()` with `vi.spyOn(Date, 'now')`
  - Remove `setTimeout` delays
- [ ] No implementation detail testing
  - Remove tests for keyboard handlers, CSS classes, internal state

**Anti-patterns to remove**:
```typescript
// ❌ Remove: Testing mock calls
expect(mockService.doSomething).toHaveBeenCalled();

// ✅ Add: Testing actual behavior
const result = await service.doSomething();
expect(result.status).toBe("success");

// Verify with real database
const dbRecord = await globalThis.services.db.select()...
expect(dbRecord).toMatchObject({ status: "success" });
```

---

### Step 5: Check for Helpers

**Tasks**:
- [ ] Can use `mockClerk()` helper?
  - If mocking Clerk auth, use helper from `@/__tests__/clerk-mock`
- [ ] Can share MSW handlers?
  - Move HTTP mocks to `mocks/handlers/` directory
- [ ] Can extract common test setup?
  - Create helper functions for repeated setup patterns

**Example helper usage**:
```typescript
// BEFORE: Verbose Clerk mock
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
const mockAuth = vi.mocked(auth);
mockAuth.mockResolvedValue({ userId: testUserId });

// AFTER: Use helper
import { mockClerk } from '@/__tests__/clerk-mock';
mockClerk({ userId: testUserId });
```

---

## Prohibited Patterns (Zero Tolerance)

### 1. TypeScript `any` Type

**PROHIBITION**: Project has zero tolerance for `any` types.

```typescript
// ❌ Bad: Using any
const data: any = fetchData();

// ✅ Good: Use unknown with type narrowing
const data: unknown = fetchData();
if (isValidData(data)) {
  // Use data with proper type
}

// ✅ Good: Define proper interfaces
interface UserData {
  id: string;
  name: string;
}
const data: UserData = fetchData();
```

---

### 2. Lint/Type Suppressions

**PROHIBITION**: Zero tolerance for suppression comments.

**Prohibited comments**:
- `// eslint-disable` or `/* eslint-disable */`
- `// oxlint-disable` or `/* oxlint-disable */`
- `// @ts-ignore`
- `// @ts-nocheck`
- `// @ts-expect-error`
- `// prettier-ignore`

**Prohibited plugins**:
- `eslint-plugin-only-warn`

**Always fix the root cause**:
```typescript
// ❌ Bad: Suppressing the warning
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data: any = fetchData();

// ✅ Good: Fix with proper typing
const data: unknown = fetchData();
if (isValidData(data)) {
  // Use data with type narrowing
}
```

---

### 3. Dynamic Imports

**PROHIBITION**: Zero tolerance for dynamic `import()` in production code.

```typescript
// ❌ Bad: Dynamic import
async function generateToken() {
  const crypto = await import("crypto");
  return crypto.randomBytes(32).toString("base64url");
}

// ✅ Good: Static import
import { randomBytes } from "crypto";

function generateToken() {
  return randomBytes(32).toString("base64url");
}
```

**Why harmful**:
- Break tree-shaking and bundle optimization
- Add unnecessary async complexity
- Make dependency analysis harder
- Hide import errors until runtime

---

### 4. Hardcoded URLs and Configuration

**PROHIBITION**: Never hardcode URLs or environment-specific values.

```typescript
// ❌ Bad: Hardcoded URL
const apiUrl = "https://api.vm7.ai";

// ❌ Bad: Hardcoded with fallback
const apiUrl = process.env.API_URL || "https://api.vm7.ai";

// ✅ Good: Use centralized configuration
const apiUrl = env().API_URL;

// ✅ Good: Fail fast if missing
if (!process.env.API_URL) {
  throw new Error("API_URL not configured");
}
```

---

### 5. Fallback Patterns

**PROHIBITION**: No fallback/recovery logic - fail fast.

```typescript
// ❌ Bad: Fallback to another secret
const jwtSecret = process.env.JWT_SECRET ||
                  process.env.SOME_OTHER_SECRET ||
                  "default-secret";

// ❌ Bad: Silent fallback
if (!config) {
  config = getDefaultConfig(); // Hides misconfiguration
}

// ✅ Good: Fail fast with clear error
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("JWT_SECRET not configured");
}
```

**Rationale**:
- Fallbacks make debugging harder
- Configuration errors should be caught during deployment
- Explicit failures are easier to fix
- Less code paths = simpler code

---

### 6. Direct Database Operations in Tests

**PROHIBITION**: Tests should use API endpoints for data setup.

```typescript
// ❌ Bad: Direct database operation
await db.insert(PROJECTS_TBL).values({ id, userId, name });

// ✅ Good: Use API endpoint
await POST("/api/projects", { json: { name } });
```

**Rationale**:
- Direct DB operations duplicate business logic
- Makes tests brittle when schema changes
- Bypasses validation and business rules
