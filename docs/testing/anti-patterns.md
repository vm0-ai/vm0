# Testing Anti-Patterns

This document catalogs the testing anti-patterns we've encountered and learned to avoid. Each pattern is something we've seen in real code—often our own—and represents hard-won lessons about what makes tests valuable versus what makes them maintenance liabilities.

## AP-1: Testing Mock Calls Instead of Behavior

Perhaps the most seductive anti-pattern. You write a test that verifies your mock was called, and it feels productive—you're asserting something, after all. But here's the problem: this test passes even when the actual behavior is completely broken.

```typescript
// This test proves nothing
it("should call getUser", async () => {
  await someFunction();
  expect(mockGetUser).toHaveBeenCalled();
});
```

What does this test actually verify? That your code calls a function. It doesn't verify that the function returns useful data, that your code handles the response correctly, or that the user sees what they should see.

```typescript
// This test verifies behavior
it("should retrieve and display user data", async () => {
  const result = await someFunction();
  expect(result.userName).toBe("expected-name");
  expect(result.email).toBe("user@example.com");
});
```

The second test fails if `someFunction()` breaks. The first test keeps passing because the mock was still called, even if everything after that call is wrong.

**The principle**: Test outcomes, not call patterns. If you find yourself writing `toHaveBeenCalled()`, ask yourself: "What behavior am I actually trying to verify?"

---

## AP-2: Direct Fetch Mocking

When you need to test HTTP behavior, it's tempting to mock `fetch` directly:

```typescript
// Brittle and unrealistic
vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
```

This approach has several problems. First, you're not testing the actual request construction—the URL building, headers, body formatting. Second, the mock doesn't behave like real HTTP. Third, you've coupled your test to the implementation detail that your code uses `fetch` specifically.

We use MSW (Mock Service Worker) instead:

```typescript
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const server = setupServer(
  http.get('https://api.example.com/users', () => {
    return HttpResponse.json({ users: [{ id: 1, name: 'Test' }] });
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

MSW intercepts at the network level, so your code makes real `fetch` calls that get intercepted. This tests the actual request construction and catches bugs in URL building, header formatting, and request body serialization.

**Exception**: The only acceptable case for direct fetch mocking is when testing a fetch wrapper itself—testing the mechanism, not code that uses it.

---

## AP-3: Filesystem Mocking

```typescript
// This tests mock behavior, not file operations
vi.mock("fs");
vi.mock("fs/promises");

it("should write file", () => {
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);
  registry.register("172.16.0.2", "run-123", "token-abc");
  expect(mockWriteFileSync).toHaveBeenCalled();
});
```

This test passes even if the actual file writing is broken. It doesn't catch permission issues, race conditions, encoding problems, or file path bugs.

Use real filesystems with temp directories:

```typescript
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "test-"));
});

afterEach(() => {
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

This approach catches real bugs. The temp directory is created and cleaned up automatically, so there's no risk of test pollution.

**Known exception**: `ip-pool.test.ts` still uses fs mocks due to hardcoded paths in production code. This is technical debt we haven't addressed yet.

---

## AP-4: Mocking Internal Code

This is our highest priority anti-pattern to avoid. If you find yourself writing `vi.mock()` with a relative path, stop and reconsider.

```typescript
// These are wrong
vi.mock("../../blob/blob-service")
vi.mock("../../storage/storage-service")
vi.mock("../agent-session-service")
```

**The Relative Path Rule**: If the path in `vi.mock()` starts with `../` or `../../`, it's almost always wrong.

Why is this harmful? When you mock internal code, you're not testing real behavior. You're testing that your test correctly orchestrates mocks. This creates false confidence—your test passes while production breaks because the real code has bugs you never exercised.

What should you mock? Only external third-party packages:

```typescript
// These are correct
vi.mock("@clerk/nextjs")
vi.mock("@aws-sdk/client-s3")
vi.mock("@e2b/code-interpreter")
vi.mock("@anthropic-ai/sdk")
```

These are external services that require API keys, network access, or external infrastructure. Your internal code—services, utilities, database access—should use real implementations.

Here's the mock hierarchy:

| Category | Example | Mock? |
|----------|---------|-------|
| Third-party SaaS | `@clerk/nextjs`, `@aws-sdk/client-s3` | Yes |
| Node.js built-ins | `child_process` | Sometimes |
| Database | `globalThis.services.db` | Never |
| Internal services | `../../lib/*` | Never |
| Internal utilities | `../../utils/*` | Never |

When you use real internal code, you catch real bugs. When you mock it, you're just verifying that your mock orchestration is correct.

---

## AP-5: Fake Timers

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
});
```

Fake timers feel convenient for tests that involve time, but they mask real timing issues. Race conditions, actual timeout behavior, and real async patterns all get hidden behind the fake timer abstraction.

If you need deterministic time, mock only what you need:

```typescript
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(
    new Date("2024-01-15T12:00:00Z").getTime()
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

This approach is more specific—you're only controlling `Date.now()`, not all timers. Tests still handle real async behavior and can catch actual race conditions.

---

## AP-6: Partial Internal Mocks

Sometimes you see code like this:

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

This partial mocking—where you import the real module and selectively replace functions—is confusing and brittle. It's also a sign that you're mocking internal code, which violates AP-4.

The solution is to use the real implementation. If your tests require partial mocking to pass, that often indicates a design issue in the production code—maybe it's doing too much, or has too many dependencies.

```typescript
// Use real @vm0/core implementation
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

## AP-7: Testing Implementation Details

Tests that verify internal function calls, keyboard handlers, CSS classes, or React state are testing implementation, not behavior.

```typescript
// Testing keyboard handlers
it("should prevent form submission on Shift+Enter", () => {
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(mockSubmit).not.toHaveBeenCalled();
});

// Testing CSS classes
it("should have correct CSS classes", () => {
  expect(button).toHaveClass("btn-primary");
});

// Testing internal state
it("should update state correctly", () => {
  expect(component.state.count).toBe(1);
});
```

These tests are brittle. They break when you refactor—change the keyboard handler, rename a CSS class, restructure state—even though the user-visible behavior hasn't changed.

Test what users see:

```typescript
// Test user-visible behavior
it("should submit form when user presses send button", () => {
  userEvent.click(sendButton);
  expect(screen.getByText("Message sent")).toBeInTheDocument();
});

// Test outcome, not state
it("should increment counter when clicked", () => {
  userEvent.click(button);
  expect(screen.getByText("Count: 1")).toBeInTheDocument();
});
```

---

## AP-8: Over-Testing

Not everything needs a test. We've seen tests for:

- Every HTTP error status code (401, 403, 404, 400, 500...)
- Schema validation (proving that Zod works)
- Loading spinners and trivial UI states
- Exact UI text content

```typescript
// Over-testing error responses
it("should return 401 when not authenticated", async () => {...});
it("should return 404 when not found", async () => {...});
it("should return 400 when invalid", async () => {...});
it("should return 500 when server errors", async () => {...});
```

This adds maintenance burden without catching real bugs. Trust your libraries—Zod validates schemas, React renders conditional content, HTTP frameworks return status codes.

Focus tests on business logic and integration points:

```typescript
// Test the actual authentication logic and business rules
it("should handle authentication flow correctly", async () => {
  const response = await authenticateUser(credentials);
  expect(response.token).toBeDefined();
  expect(response.user.permissions).toContain("read");
});
```

---

## AP-9: Console Mocking Without Assertions

```typescript
beforeEach(() => {
  console.log = vi.fn();
  console.error = vi.fn();
});

it("should do something", () => {
  // Test code that logs, but no assertions on logs
});
```

If you're mocking console but not asserting on it, you're just suppressing output—which makes debugging harder without adding any test value.

Either assert on logs:

```typescript
it("should log error details", () => {
  const consoleSpy = vi.spyOn(console, "error");
  performAction();
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("error"));
});
```

Or just let console output appear. Natural console output in tests is fine and often helpful for debugging.

---

## AP-10: Direct Component Rendering

In our platform app, we have a specific anti-pattern: rendering components directly instead of going through the production initialization flow.

```typescript
// Doesn't match production
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

This test doesn't exercise the same code paths as production. It misses setup commands, bootstrap logic, routing, and initialization sequences.

Instead, use the production flow:

```typescript
import { setupPage } from "../../__tests__/helper.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

it("should render the page", async () => {
  // Bootstrap app and navigate (like main.ts does)
  await setupPage({
    context,
    path: "/my-page",
  });

  // Verify page was rendered
  expect(screen.getByText("Expected Content")).toBeDefined();
});
```

The `setupPage()` helper mirrors `main.ts` bootstrap: it sets the pathname, configures auth, bootstraps the app, and renders via `setupRouter()`. This catches initialization bugs that direct rendering would miss.

---

## Quick Checklist

When reviewing tests, watch for these patterns:

**Mocking Issues**:
- [ ] Mocking internal services (`../../lib/*`)
- [ ] Mocking `globalThis.services.db`
- [ ] Direct fetch mocking (use MSW instead)
- [ ] Filesystem mocking (use temp directories)
- [ ] Partial mocks with `vi.importActual()`

**Timer Issues**:
- [ ] Using `vi.useFakeTimers()`
- [ ] Using `vi.advanceTimersByTime()`
- [ ] Artificial delays (`setTimeout` in tests)

**Test Quality Issues**:
- [ ] Testing that mocks were called (not behavior)
- [ ] Testing UI text content or CSS classes
- [ ] Testing empty/loading states without logic
- [ ] Over-testing error status codes
- [ ] Over-testing schema validation
- [ ] Direct component rendering (use bootstrap$)

**Required Practices**:
- [ ] `vi.clearAllMocks()` in `beforeEach`
- [ ] `initServices()` in `beforeAll` (for database tests)
- [ ] Database cleanup in `afterEach`
- [ ] Only mock third-party dependencies
- [ ] Test real behavior and outcomes
