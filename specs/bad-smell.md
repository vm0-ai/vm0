# Bad Code Smells

This document defines code quality issues and anti-patterns to identify during code reviews.

## 1. Mock Analysis
- Identify new mock implementations
- Suggest non-mock alternatives where possible
- List all new mocks for user review
- **NEVER mock fetch API directly** - always use MSW (Mock Service Worker) instead

### Never Mock Fetch - Always Use MSW

**PROHIBITION: Direct fetch mocking is not allowed**

Tests should NEVER mock the global `fetch` function using `vi.fn()`, `vi.stubGlobal()`, or direct assignment to `window.fetch`. Always use **MSW (Mock Service Worker)** for network mocking.

**Why direct fetch mocking is harmful:**
- Doesn't accurately represent real HTTP behavior (headers, status codes, streaming)
- Doesn't test request/response serialization
- Makes tests brittle and tied to implementation details
- Misses request URL construction bugs
- Doesn't verify request headers, body formatting, or HTTP methods
- MSW provides realistic HTTP mocking with better ergonomics

**Prohibited patterns:**
```typescript
// ❌ Bad: Direct fetch mocking with vi.fn()
const mockFetch = vi.fn().mockResolvedValue(new Response());
vi.stubGlobal("fetch", mockFetch);

// ❌ Bad: Direct window.fetch assignment
window.fetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ data: "test" }),
});

// ❌ Bad: Using vi.spyOn on global fetch
vi.spyOn(global, "fetch").mockResolvedValue(
  new Response(JSON.stringify({ data: "test" }))
);
```

**Correct approach - Use MSW:**
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

**Benefits of MSW:**
- Realistic HTTP behavior (status codes, headers, streaming)
- Tests actual request construction (URL, headers, body)
- Declarative API handlers (easier to read and maintain)
- Works in both Node.js tests and browser
- Catches request formatting bugs
- Better error simulation (network errors, timeouts)

**Exception**: For platform signal tests (fetch.test.ts), direct fetch mocking is acceptable when testing the fetch wrapper itself, not actual HTTP calls.

### Never Mock Your Own Code - Only Mock Third-Party Dependencies

**PROHIBITION: Mocking internal application code is not allowed**

Tests should NEVER mock internal modules, components, or functions from your own codebase. Only mock third-party dependencies (npm packages).

**Why mocking your own code is harmful:**
- Hides bugs in the actual code path
- Creates false confidence (test passes but production fails)
- Makes refactoring harder (tests depend on implementation details)
- Reduces test value (you're not testing real behavior)
- Breaks integration testing (mocks bypass actual logic)

**Prohibited patterns:**
```typescript
// ❌ Bad: Mocking your own component
vi.mock("../../layout/sidebar.tsx", () => ({
  Sidebar: () => null,
}));

// ❌ Bad: Mocking your own utility function
vi.mock("../../lib/utils.ts", () => ({
  formatDate: vi.fn().mockReturnValue("2024-01-01"),
}));

// ❌ Bad: Mocking your own service
vi.mock("../../services/user-service.ts", () => ({
  getUser: vi.fn().mockResolvedValue({ id: "123" }),
}));
```

**Correct approach - Mock only third-party dependencies:**
```typescript
// ✅ Good: Mock third-party package
vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return { /* mock implementation */ };
  },
}));

// ✅ Good: Use MSW for API calls (not mocking your own code)
server.use(
  http.get("/api/users", () => HttpResponse.json({ users: [] }))
);

// ✅ Good: For missing third-party exports, use vitest.config.ts alias
// vitest.config.ts
resolve: {
  alias: {
    "@clerk/clerk-react/experimental": path.resolve(
      __dirname,
      "./src/test/mocks/clerk-react-experimental.tsx",
    ),
  },
}
```

**What to do instead:**
- If a component is complex, extract testable logic into smaller units
- Test the full integration path rather than mocking parts of it
- Use MSW for external API dependencies
- Use dependency injection if you need to swap implementations
- For missing third-party modules, create stub files and use vitest alias

**Benefits of not mocking your own code:**
- Tests catch real bugs in production code paths
- Refactoring is easier (tests don't depend on internals)
- Higher confidence in test results
- Integration testing happens naturally
- Forces better code organization

## 2. Test Coverage
- Evaluate test quality and completeness
- Check for missing test scenarios
- Assess test maintainability

### Test Initialization Pattern - Match Production Startup Flow

**PROHIBITION: Direct component rendering with StoreProvider is not allowed**

Component tests should follow the same initialization flow as production (main.ts) instead of directly rendering components with StoreProvider.

**Why direct StoreProvider rendering is harmful:**
- Tests don't match production initialization
- Misses setup commands and bootstrap logic
- Can't catch initialization bugs
- Inconsistent with real application flow
- Lower confidence in test results

**Prohibited patterns:**
```typescript
// ❌ Bad: Direct component rendering
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

**Correct approach - Use bootstrap + navigate like main.ts:**
```typescript
// ✅ Good: Use bootstrap$ and navigate$ to match production flow
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

**Key points:**
1. Use `bootstrap$` to initialize the app (sets up routes, auth, etc.)
2. Use `navigate$` to trigger page setup (don't call setup commands directly)
3. Use `setupRouter` to establish the same rendering context as main.ts
4. Use `testContext()` for proper cleanup and signal management
5. Follow the same bootstrap → route → setup → render flow as production

**Benefits of matching production flow:**
- Catches initialization bugs
- Tests run through same code path as production
- Higher confidence in test results
- Makes tests resilient to refactoring
- Easier to debug when tests fail (matches production)

## 3. Error Handling
- Identify unnecessary try/catch blocks
- Suggest fail-fast improvements
- Flag over-engineered error handling

## 4. Interface Changes
- Document new/modified public interfaces
- Highlight breaking changes
- Review API design decisions

## 5. Timer and Delay Analysis
- Identify artificial delays and timers in production code
- **PROHIBIT fakeTimer/useFakeTimers usage in tests** - they mask real timing issues
- Flag timeout increases to pass tests
- Suggest deterministic alternatives to time-based solutions
- Tests should handle real async behavior, not manipulate time

## 6. Prohibition of Dynamic Imports
- **ZERO tolerance for dynamic `import()` in production code** - use static imports only
- **Prohibited patterns:**
  - `await import("module")` - Use static `import` at file top instead
  - `import("module").then(...)` - Use static `import` at file top instead
  - Conditional imports like `if (condition) { await import(...) }` - Restructure code to use static imports
- **Why dynamic imports are harmful:**
  - Break tree-shaking and bundle optimization
  - Add unnecessary async complexity to synchronous operations
  - Make dependency analysis harder for tools
  - Increase code complexity without real benefits
  - Hide import errors until runtime instead of catching at build time
- **Always use static imports:**
  ```typescript
  // ❌ Bad: Dynamic import adds unnecessary async
  async function generateToken() {
    const crypto = await import("crypto");
    return crypto.randomBytes(32).toString("base64url");
  }

  // ✅ Good: Static import at file top
  import { randomBytes } from "crypto";

  function generateToken() {
    return randomBytes(32).toString("base64url");
  }

  // ❌ Bad: Dynamic import for "lazy loading"
  async function handleClick() {
    const { E2BExecutor } = await import("./e2b-executor");
    await E2BExecutor.doSomething();
  }

  // ✅ Good: Static import
  import { E2BExecutor } from "./e2b-executor";

  async function handleClick() {
    await E2BExecutor.doSomething();
  }
  ```
- **Rare exceptions (must be justified):**
  - Truly optional dependencies that may not exist (e.g., dev-only tools)
  - Route-based code splitting in Next.js (handled by framework automatically)
  - Testing utilities that need to be mocked (prefer static imports with mocking instead)

## 7. Database and Service Mocking in Web Tests
- Tests under `apps/web` should NOT mock `globalThis.services`
- Use real database connections for tests - test database is already configured
- Avoid mocking `globalThis.services.db` - use actual database operations
- Test environment variables are properly set up for database access
- Real database usage ensures tests catch actual integration issues

## 8. Test Mock Cleanup
- All test files MUST call `vi.clearAllMocks()` in `beforeEach` hooks
- Prevents mock state leakage between tests
- Eliminates flaky test behavior from persistent mock state
- Example:
  ```typescript
  beforeEach(() => {
    vi.clearAllMocks();
  });
  ```

## 9. TypeScript `any` Type Usage
- Project has zero tolerance for `any` types
- Use `unknown` for truly unknown types and implement proper type narrowing
- Define proper interfaces for API responses and data structures
- Use generics for flexible typing instead of `any`
- `any` disables TypeScript's type checking and should never be used

## 10. Artificial Delays in Tests
- Tests should NOT contain artificial delays like `setTimeout` or `await new Promise(resolve => setTimeout(resolve, ms))`
- Artificial delays cause test flakiness and slow CI/CD pipelines
- **DO NOT use `vi.useFakeTimers()` or mock timers** - handle real async behavior properly
- Use proper event sequencing and async/await instead of delays
- Delays and fake timers mask actual race conditions that should be fixed

## 11. Hardcoded URLs and Configuration
- Never hardcode URLs or environment-specific values
- Use centralized configuration from `env()` function
- Avoid hardcoded fallback URLs like `"https://vm7.ai"`
- Server-side code should not use `NEXT_PUBLIC_` environment variables
- All configuration should be environment-aware

## 12. Direct Database Operations in Tests
- Tests should use API endpoints for data setup, not direct database operations
- Direct DB operations duplicate business logic from API endpoints
- Makes tests brittle when schema or business logic changes
- Example - use API instead of direct DB:
  ```typescript
  // ❌ Bad: Direct database operation
  await db.insert(PROJECTS_TBL).values({ id, userId, name });

  // ✅ Good: Use API endpoint
  await POST("/api/projects", { json: { name } });
  ```

## 13. Avoid Fallback Patterns - Fail Fast
- **No fallback/recovery logic** - errors should fail immediately and visibly
- Fallback patterns increase complexity and hide configuration problems
- When critical dependencies are missing, throw errors instead of falling back
- Examples of bad fallback patterns:
  ```typescript
  // ❌ Bad: Fallback to another secret
  const jwtSecret = process.env.JWT_SECRET ||
                    process.env.SOME_OTHER_SECRET ||
                    "default-secret";

  // ❌ Bad: Silent fallback behavior
  if (!config) {
    config = getDefaultConfig(); // Hides misconfiguration
  }

  // ✅ Good: Fail fast with clear error
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET not configured");
  }
  ```
- Rationale:
  - Fallbacks make debugging harder - you don't know which path was taken
  - Configuration errors should be caught during deployment, not hidden
  - Explicit failures are easier to fix than subtle wrong behavior
  - Less code paths = simpler code = easier to maintain

## 14. Prohibition of Lint/Type Suppressions
- **ZERO tolerance for suppression comments** - fix the issue, don't hide it
- **Prohibited comments:**
  - `// eslint-disable` or `/* eslint-disable */` - Never disable ESLint rules
  - `// oxlint-disable` or `/* oxlint-disable */` - Never disable OxLint rules
  - `// @ts-ignore` - Never ignore TypeScript errors
  - `// @ts-nocheck` - Never skip TypeScript checking for entire files
  - `// @ts-expect-error` - Don't expect errors, fix them
  - `// prettier-ignore` - Follow formatting rules consistently
- **Prohibited plugins and configurations:**
  - `eslint-plugin-only-warn` - Never convert errors to warnings globally
  - Any ESLint plugin or configuration that downgrades error severity to bypass lint checks
- **Why suppressions are harmful:**
  - They accumulate technical debt silently
  - Hide real problems that could cause runtime failures
  - Make code reviews less effective
  - Create inconsistent code quality across the codebase
- **Always fix the root cause:**
  ```typescript
  // ❌ Bad: Suppressing the warning
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = fetchData();

  // ✅ Good: Fix with proper typing
  const data: unknown = fetchData();
  if (isValidData(data)) {
    // Use data with proper type narrowing
  }

  // ❌ Bad: Ignoring TypeScript error
  // @ts-ignore
  window.myGlobalVar = value;

  // ✅ Good: Properly extend global types
  declare global {
    interface Window {
      myGlobalVar: typeof value;
    }
  }
  ```

## 15. Avoid Bad Tests
- **Fake tests** - Tests that don't actually execute the code under test, but instead test mock implementations
  - These tests may pass while the real code is broken
  - Example: Mocking a function and then testing the mock's behavior instead of the real implementation
- **Duplicating implementation in tests** - Copying implementation logic into test assertions
  - When implementation changes, tests won't catch regressions
  - Tests should verify behavior, not replicate code
- **Over-testing error responses** - Excessive boilerplate tests for HTTP status codes
  - Don't write repetitive tests for every 401/404/400 scenario
  - Focus on meaningful error handling, not HTTP status code validation
  - Example:
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
- **Over-testing schema validation** - Redundant validation tests for Zod schemas
  - Zod already validates at runtime - no need to test that Zod works
  - Trust the schema library; test business logic instead
- **Over-mocking** - Mocking too many dependencies
  - Reduces confidence that integrated components work together
  - Prefer integration tests with real dependencies when possible
  - Only mock external services, network calls, or slow operations
  - Tests that only verify mocks were called provide zero confidence
  - Example:
    ```typescript
    // ❌ Bad: Only testing that mocks were called
    it("should call getUser", async () => {
      await someFunction();
      expect(mockGetUser).toHaveBeenCalled();
    });

    // ✅ Good: Test actual behavior with real or minimal mocks
    it("should retrieve and display user data", async () => {
      const result = await someFunction();
      expect(result.userName).toBe("expected-name");
    });
    ```
- **Console output mocking without assertions** - Mocking console.log/error without verifying output
  - Mocking console methods just to suppress output adds no value
  - If you need to verify logging, assert on the log content
  - Otherwise, let console output appear naturally in tests
  - Example:
    ```typescript
    // ❌ Bad: Pointless console mocking
    beforeEach(() => {
      console.log = vi.fn();
      console.error = vi.fn();
    });

    // ✅ Good: Either assert on logs or don't mock
    it("should log error details", () => {
      const consoleSpy = vi.spyOn(console, "error");
      performAction();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("error"));
    });
    ```
- **Testing UI implementation details** - Testing internal React/UI mechanics instead of user behavior
  - Don't test keyboard event handlers, CSS classes, or internal state
  - Test what users see and do, not how React implements it
  - Example:
    ```typescript
    // ❌ Bad: Testing implementation details
    it("should prevent form submission on Shift+Enter", () => {
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(mockSubmit).not.toHaveBeenCalled();
    });

    it("should have correct CSS classes", () => {
      expect(button).toHaveClass("btn-primary");
    });

    // ✅ Good: Test user-visible behavior
    it("should submit form when user presses send button", () => {
      userEvent.click(sendButton);
      expect(screen.getByText("Message sent")).toBeInTheDocument();
    });
    ```
- **Testing empty/loading/error states without logic** - Trivial tests for states with no business logic
  - Don't test that loading spinner appears - it's just conditional rendering
  - Don't test that error message displays - it's just JSX
  - Test the logic that causes these states, not the states themselves
  - Example:
    ```typescript
    // ❌ Bad: Testing trivial rendering
    it("should show loading spinner when loading", () => {
      render(<Component isLoading={true} />);
      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("should show error when error prop is set", () => {
      render(<Component error="Something failed" />);
      expect(screen.getByText("Something failed")).toBeInTheDocument();
    });

    // ✅ Good: Test the logic that produces these states
    it("should load data and handle errors", async () => {
      render(<Component />);
      // Verify actual data fetching, error handling logic
      await waitFor(() => {
        expect(screen.getByText("Loaded data")).toBeInTheDocument();
      });
    });
    ```
- **Testing specific UI text content** - Brittle tests that break when copy changes
  - Don't test exact heading text, button labels, or help text
  - Test functionality and user flows, not marketing copy
  - Use data-testid for elements that need identification
  - Example:
    ```typescript
    // ❌ Bad: Testing exact text content
    it("should display correct heading", () => {
      expect(screen.getByRole("heading")).toHaveTextContent("Welcome to Dashboard");
    });

    it("should show help text", () => {
      expect(screen.getByText("Click here to get started")).toBeInTheDocument();
    });

    // ✅ Good: Test behavior, not copy
    it("should allow user to create new project", async () => {
      await userEvent.click(screen.getByTestId("create-project-button"));
      expect(screen.getByTestId("project-form")).toBeVisible();
    });
    ```

## 16. Mocking Internal Code - AP-4 Anti-Pattern (Issue #1335)

Based on systematic review of 70+ test files, tests should **only mock third-party packages from node_modules**, not project internal code.

**Rule**: If it starts with `../../` or `../`, you probably shouldn't mock it.

### What is AP-4?

Tests that mock **project internal code** (database, services, utilities) instead of using real implementations available in vitest.

**CRITICAL: Only mock third-party external services from node_modules!**

### The "Relative Path Rule"

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
vi.mock("../storage-resolver")            // Internal utility!

// ❌ BAD: Project infrastructure
const mockDb = { select: vi.fn() }        // Mock database!
globalThis.services.db = mockDb           // Mock database!
```

### What Counts as AP-4 Violation

**❌ Mocking project database:**
- `globalThis.services.db` (project PostgreSQL database)
- Database query methods (select, insert, update, delete)

**❌ Mocking project internal services:**
- `../../blob/blob-service` (internal service)
- `../../agent-session/agent-session-service` (internal service)
- `../../storage/storage-service` (internal service)
- `../../run/run-service` (internal service)
- `../../e2b/e2b-service` (internal service)
- Any relative import path `../../*` or `../*`

**❌ Mocking project infrastructure:**
- File system operations (use real file system or temp directories)
- Environment variables (use real env or test config)
- Internal utilities and helpers

### What is Acceptable to Mock

**✅ Third-party external services (from node_modules):**
- `@clerk/nextjs` - Authentication SaaS
- `@aws-sdk/client-s3` - AWS cloud storage
- `@e2b/code-interpreter` - Sandbox SaaS
- `@anthropic-ai/sdk` - AI API
- `@axiomhq/js` - Logging SaaS
- `@stripe/stripe-js` - Payment API
- Other third-party packages that require API keys or external infrastructure

**✅ Node.js built-ins:**
- `fs` - File system operations (when testing file I/O logic)
- `child_process` - Process spawning
- Other Node.js core modules

**✅ Next.js framework APIs:**
- `next/headers` - For mocking request headers in tests

### Bad Example 1 - Mocking Project Database

**File**: `runner-auth.test.ts:38-65`

```typescript
// ❌ WRONG: Mocking project database
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

beforeEach(() => {
  (globalThis as any).services = {
    db: mockDb,  // ❌ Mocking project database
    env: mockEnv,
  };
});

// Test only verifies mock was called
mockDb.limit.mockResolvedValue([{ token: TEST_CLI_TOKEN, userId: TEST_USER_ID }]);
const result = await getRunnerAuth();
expect(mockDb.select).toHaveBeenCalled();  // ❌ Testing mock!
```

**Why this is wrong:**
- Tests mock behavior, not actual database logic
- Misses real database constraints, triggers, and edge cases
- Brittle - breaks when implementation changes even if behavior is correct
- False confidence - tests pass but real database issues remain

### Bad Example 2 - Mocking Internal Service

**File**: `session-history-service.test.ts:6-11`

```typescript
// ❌ WRONG: Mocking project internal service
vi.mock("../../blob/blob-service", () => ({
  blobService: {
    uploadBlobs: vi.fn(),
    downloadBlob: vi.fn(),
  },
}));

it("should save session history", async () => {
  vi.mocked(blobService.uploadBlobs).mockResolvedValue({
    hashes: new Map([["session-history-hash.jsonl", mockHash]]),
  });

  const result = await sessionHistory.store(content);

  expect(blobService.uploadBlobs).toHaveBeenCalled();  // ❌ Testing mock!
  expect(result).toBe(mockHash);  // ❌ Just echoing mock return value!
});
```

**Why this is wrong:**
- Tests mock orchestration, not real blob storage logic
- Misses blob deduplication bugs, refCount issues, S3 upload failures
- Mock behavior may not match actual service behavior

### Bad Example 3 - API Route Mocking Internal Services

**File**: `app/api/agent/runs/__tests__/route.test.ts`

```typescript
// ❌ WRONG: Mocking multiple internal services
vi.mock("../../../../../src/lib/run", () => ({
  runService: {
    buildExecutionContext: vi.fn().mockResolvedValue({}),
    prepareAndDispatch: vi.fn().mockResolvedValue({ status: "pending" }),
  },
}));

vi.mock("../../../../../src/lib/auth/sandbox-token", () => ({
  generateSandboxToken: vi.fn().mockResolvedValue("mock-token"),
}));

vi.mock("../../../../../src/lib/axiom", () => ({
  queryAxiom: vi.fn().mockResolvedValue([]),
}));

it("should create a run", async () => {
  const response = await POST(request);
  expect(runService.prepareAndDispatch).toHaveBeenCalled();  // ❌ Testing mocks!
});
```

**Why this is wrong:**
- API routes are **main integration points** - should be high-value integration tests
- Mocking all services means tests only verify mock calls, not actual API logic
- Misses real service integration bugs, database constraints, transaction issues
- Currently low-value tests (verify mock orchestration instead of real behavior)

### Good Example 1 - Real Database + Mock External S3 Only

**File**: `blob-service.test.ts:31-53` (Reference example from #1335)

```typescript
// ✅ Mock third-party external service (AWS S3), NOT internal code
vi.mock("@aws-sdk/client-s3");

beforeAll(async () => {
  // ✅ Initialize real database connection
  initServices();
  const blobModule = await import("../blob-service");
  BlobService = blobModule.BlobService;
});

beforeEach(async () => {
  // ✅ Clean up test data using real database
  await globalThis.services.db
    .delete(blobs)
    .where(like(blobs.hash, `${TEST_HASH_PREFIX}%`));
});

it("should upload new blobs to S3 and insert into database", async () => {
  // ✅ Mock external AWS S3 service
  vi.mocked(s3Client.uploadS3Buffer).mockResolvedValue(undefined);

  // ✅ Use real blob-service implementation
  const result = await blobService.uploadBlobs(files);

  // ✅ Verify with real database query
  const dbBlobs = await globalThis.services.db
    .select()
    .from(blobs)
    .where(eq(blobs.hash, hash1));

  expect(dbBlobs).toHaveLength(1);
  expect(dbBlobs[0]!.refCount).toBe(1);
});
```

**Why this is correct:**
- Only mocks external AWS S3 service (acceptable per AP-4)
- Uses real database with `initServices()`
- Tests actual blob storage logic including deduplication and refCount
- Verifies real database state, not mocks
- Catches actual bugs in database constraints and service integration

### Good Example 2 - Real Services + Mock External Auth Only

**File**: `agent-session-service.test.ts:22-132`

```typescript
// ✅ Mock third-party external service (Clerk)
vi.mock("@clerk/nextjs", () => ({
  auth: vi.fn().mockResolvedValue({
    userId: "test-user-123",
    sessionId: "test-session-456",
  }),
}));

// ✅ Use real database for project data
beforeAll(() => {
  initServices();
});

beforeEach(async () => {
  // ✅ Clean up test data with real database
  await globalThis.services.db
    .delete(agentSessions)
    .where(eq(agentSessions.userId, TEST_USER_ID));
});

it("should create user record after Clerk authentication", async () => {
  // Clerk mock provides auth context
  const result = await createUserProfile();

  // ✅ Verify with real database
  const user = await globalThis.services.db
    .select()
    .from(users)
    .where(eq(users.clerkId, "test-user-123"));

  expect(user).toHaveLength(1);
});
```

**Why this is correct:**
- Only mocks external Clerk auth service (third-party SaaS)
- Uses real database for all data operations
- Tests actual service integration and business logic
- Verifies real database constraints and relationships

### Good Example 3 - Only Mock Node.js Built-ins

**File**: `vm-registry.test.ts:6`

```typescript
// ✅ Only mock Node.js built-in
vi.mock("fs");

// ✅ NO internal modules mocked!

beforeEach(() => {
  registry = new VMRegistry(testRegistryPath);
});

it("should register a VM with correct data", () => {
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);

  // ✅ Use real VMRegistry implementation
  registry.register("172.16.0.2", "run-123", "token-abc");

  // ✅ Verify actual atomic write pattern (write to .tmp, then rename)
  expect(mockWriteFileSync).toHaveBeenCalledWith(
    testTempPath,
    expect.any(String),
    { mode: 0o644 },
  );

  // ✅ Verify actual data structure
  const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0]![1] as string);
  expect(writtenData.vms["172.16.0.2"]).toMatchObject({
    runId: "run-123",
    sandboxToken: "token-abc",
  });
});
```

**Why this is correct:**
- Only mocks Node.js built-in `fs` module (acceptable)
- NO internal modules mocked (correct approach!)
- Tests actual VMRegistry logic with mocked file I/O
- Verifies atomic write pattern and data structure

### Summary Table

| What | Mock? | Why |
|------|-------|-----|
| `@clerk/nextjs` | ✅ Yes | Third-party SaaS, requires API key |
| `@aws-sdk/client-s3` | ✅ Yes | Third-party cloud, requires credentials |
| `@e2b/code-interpreter` | ✅ Yes | Third-party SaaS, requires API key |
| `@anthropic-ai/sdk` | ✅ Yes | Third-party API, requires API key |
| `fs`, `child_process` | ✅ Yes | Node.js built-ins for I/O operations |
| `next/headers` | ✅ Yes | Next.js framework API (test setup) |
| `globalThis.services.db` | ❌ No | Project database, use real connection |
| `../../blob/blob-service` | ❌ No | Internal service, use real implementation |
| `../../storage/*` | ❌ No | Internal service, use real implementation |
| `../../agent-session/*` | ❌ No | Internal service, use real implementation |
| `../../run/*` | ❌ No | Internal service, use real implementation |
| `../storage-resolver` | ❌ No | Internal utility, use real implementation |
| `../vm-registry` | ❌ No | Internal module, use real implementation |

### When to Use Real Implementations

- Integration tests for services that interact with database
- Testing internal service interactions and orchestration
- Testing database constraints, transactions, foreign keys
- Testing query logic and data transformations
- API route tests (main integration points)
- Any test where implementation behavior matters

### When Mocking is Acceptable

- Unit tests for pure functions (no I/O dependencies)
- **Only mock third-party services from node_modules**
- Services that require API keys or external infrastructure
- Services outside our control (Clerk, AWS, E2B, Anthropic, etc.)
- Node.js built-ins when testing I/O logic (fs, child_process)

### Impact of Fixing AP-4 Violations

**Before (with mocks):**
- Tests verify mock behavior, not actual implementation
- Misses real bugs in database constraints, service interactions
- False confidence - tests pass but real issues remain
- More brittle - breaks when implementation changes

**After (with real implementations):**
- Tests verify actual business logic and integration
- Catches real bugs in database, services, error handling
- Higher confidence - tests verify real behavior
- More maintainable - tests verify behavior, not implementation details

### Reference Files (Gold Standards)

Use these as templates when writing tests:

1. **blob-service.test.ts** - Real DB + mock external S3 only
2. **agent-session-service.test.ts** - Real services + mock Clerk only
3. **scope-service.spec.ts** - Real database CRUD operations
4. **proxy-token-service.test.ts** - Pure functions, zero mocks
5. **scope-reference.spec.ts** - Comprehensive pure function testing
6. **vm-registry.test.ts** - Correct file I/O testing (mock fs only)

### Common Violations Found (Issue #1335)

**High Priority** (mock database):
- runner-auth.test.ts (#1336)
- e2b-service.test.ts (#1344)

**Medium Priority** (mock internal services):
- storage-service.test.ts (#1358, #1340)
- run-service.test.ts (#1359)
- session-history-service.test.ts (#1360)
- proxy-manager.test.ts (#1362)
- e2b-service.test.ts (#1344 - also mocks storage-service)

**High Impact** (widespread - 28 files):
- API route tests (#1371) - Mock get-user-id, runService, sandbox-token, axiom, e2b-service

### Review Statistics (Issue #1335)

- **70+ files reviewed** across 30 tasks
- **690+ test cases** analyzed
- **Phase 2 (integration tests)**: 100% clean! 🌟
- **Overall clean rate**: ~70% (Phase 2 service tests are exemplary)
- **Main issues**: Auth tests (Phase 1) and API routes (Phase 4)

## 17. Filesystem Mocks in Tests - Technical Debt Tracking

### Problem

One test file still uses filesystem mocks because it requires code refactoring:

**turbo/apps/runner/src/lib/firecracker/__tests__/ip-pool.test.ts**

- Issue: IP pool module uses hardcoded path constants
  ```typescript
  const VM0_RUN_DIR = "/var/run/vm0";
  const REGISTRY_FILE_PATH = path.join(VM0_RUN_DIR, "ip-registry.json");
  ```
- Solution needed: Accept custom path via config, constructor parameter, or environment variable
- Impact: Would enable proper test isolation with temp directories

### Background

The project principle is to **never mock the filesystem** in tests. We should use real filesystem operations with temporary directories for better test reliability.

9 out of 10 test files have been successfully migrated to use real filesystem (issue #1404). This file remains with mocks due to tight coupling with hardcoded paths in the production code.

### Recommendation

Future refactoring should make the IP pool module accept configurable paths (similar to how VMRegistry already does) to enable real filesystem testing.

### Migrated Files (for reference)

The following files were successfully migrated to use real filesystem with temp directories:

1. `apps/cli/src/commands/__tests__/init.test.ts`
2. `apps/cli/src/commands/__tests__/compose.test.ts`
3. `apps/cli/src/commands/__tests__/cook.test.ts`
4. `apps/runner/src/lib/proxy/__tests__/vm-registry.test.ts`
5. `apps/runner/src/__tests__/config.test.ts`
6. `apps/cli/src/commands/__tests__/setup-github.test.ts`
7. `apps/cli/src/commands/schedule/__tests__/init.test.ts`
8. `apps/cli/src/lib/domain/__tests__/cook-state.test.ts`
9. `apps/runner/src/lib/proxy/__tests__/proxy-manager.test.ts`

