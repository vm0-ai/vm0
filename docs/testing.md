# Testing at vm0

## Why We Care About Testing

Good tests give us confidence to ship fast. Bad tests slow us down with false failures, missed bugs, and maintenance burden. After years of writing tests, we've learned that *how* you test matters more than *how much* you test.

Kent C. Dodds summarized it well: **"Write tests. Not too many. Mostly integration."**

This document explains our testing philosophy and the principles behind it.

## Our Testing Strategy

### The Testing Trophy

Traditional testing advice suggests a pyramid: many unit tests at the base, fewer integration tests in the middle, and a handful of E2E tests at the top. We've found the opposite works better for us.

```
        ┌─────┐
        │ E2E │           ← Few tests, happy path only
       ┌┴─────┴┐
       │ Integ │          ← Our primary tests
      ┌┴───────┴┐
      │  Static │         ← TypeScript, ESLint
      └─────────┘
```

**Integration tests are our primary tests.** They exercise real code paths, catch real bugs, and give us confidence that the system works. Unit tests, by contrast, often test implementation details that change frequently.

### Why Integration Tests?

Integration tests hit the sweet spot:

- **They exercise real code.** When you test a CLI command end-to-end, you're testing the argument parser, the validators, the business logic, and the output formatting—all at once.

- **They're fast enough.** With MSW mocking external HTTP calls, our integration tests run in milliseconds. No network latency, no flaky external services.

- **They catch real bugs.** Unit tests for individual functions often miss bugs that only appear when functions interact. Integration tests catch these.

- **They survive refactoring.** When you reorganize internal code, integration tests keep passing as long as the behavior is preserved. Unit tests break because they're coupled to implementation.

### What About Unit Tests?

We don't write unit tests. This is a deliberate choice.

When you test a CLI command via `command.parseAsync()`, you're already exercising the validators, formatters, and domain logic inside it. Writing separate unit tests for those internal functions adds maintenance burden without additional confidence.

The exception is security-critical or algorithmically complex code where the stakes of a bug are high and the logic is genuinely independent.

### E2E Tests: Happy Path Only

E2E tests are expensive. Each `vm0 run` takes about 15 seconds, involves real network calls, and can fail due to external service issues. We use E2E tests only to verify that the happy path works—that the whole system hangs together.

Error cases and edge cases belong in integration tests, where we can control the environment and test reliably.

## The Mock Boundary

The most important decision in testing is: **what do you mock?**

Our rule is simple: **mock at the system boundary, nowhere else.**

### External vs Internal

```
External (MOCK):
├── Third-party services (Clerk, E2B, AWS, Anthropic)
├── External APIs (via MSW)
└── Node.js built-ins when necessary (child_process)

Internal (USE REAL):
├── Database (globalThis.services.db)
├── Internal services
├── Internal utilities
└── Filesystem (use temp directories)
```

If you find yourself writing `vi.mock("../../lib/something")`, stop. That's internal code—use the real implementation.

### The Relative Path Rule

Here's a quick heuristic: **if the path in `vi.mock()` starts with `../` or `../../`, it's probably wrong.**

```typescript
// ✅ Good: External packages
vi.mock("@clerk/nextjs")
vi.mock("@aws-sdk/client-s3")

// ❌ Bad: Internal code
vi.mock("../../services/user-service")
vi.mock("../utils/format")
```

When you mock internal code, you're not testing real behavior. You're testing that your test correctly orchestrates mocks. That's a recipe for tests that pass while production breaks.

### Why Real Database?

We use a real database in tests, not a mock. This catches:

- SQL syntax errors
- Constraint violations
- Transaction issues
- Migration problems

The database runs locally in Docker, so tests are fast and reliable. We clean up test data between tests using unique user IDs, not by mocking the database layer.

### Why Real Filesystem?

Similarly, we use real files in a temp directory instead of mocking `fs`:

```typescript
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
```

This catches permission issues, race conditions, and encoding problems that mocks would hide.

## Common Pitfalls

We've made these mistakes so you don't have to.

### Testing Mocks Instead of Behavior

```typescript
// ❌ This test proves nothing
it("should call getUser", async () => {
  await doSomething();
  expect(mockGetUser).toHaveBeenCalled();
});

// ✅ This test verifies behavior
it("should display the user's name", async () => {
  const result = await doSomething();
  expect(result.displayName).toBe("Alice");
});
```

The first test passes even if `doSomething()` is completely broken, as long as it calls the mock. The second test verifies actual behavior.

### Direct Fetch Mocking

```typescript
// ❌ Brittle and unrealistic
vi.stubGlobal("fetch", vi.fn().mockResolvedValue(...));

// ✅ Use MSW for realistic HTTP mocking
server.use(
  http.get('/api/users', () => {
    return HttpResponse.json({ users: [...] });
  })
);
```

MSW intercepts HTTP at the network level, so your code makes real `fetch` calls that get intercepted. This tests the actual request construction—URL building, headers, body formatting—not just that `fetch` was called.

### Fake Timers

```typescript
// ❌ Hides real timing issues
vi.useFakeTimers();
vi.advanceTimersByTime(1000);

// ✅ Mock only what you need
vi.spyOn(Date, 'now').mockReturnValue(fixedTimestamp);
```

Fake timers can mask race conditions and timing bugs. If you need deterministic time, mock `Date.now()` specifically.

### Over-Testing

Not everything needs a test. We don't test:

- That Zod validates schemas (trust the library)
- Every HTTP status code (test meaningful error handling)
- UI text content (it changes frequently and isn't logic)
- Loading spinners (test the logic that triggers states)

Focus tests on business logic and integration points, not on proving that libraries work.

## Practical Guidelines

### CLI Commands

Test CLI commands via `command.parseAsync()`, mock the Web API with MSW:

```typescript
it("should create a compose", async () => {
  server.use(
    http.post("http://localhost:3000/api/composes", () => {
      return HttpResponse.json({ id: "cmp-123" });
    })
  );

  await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining("Compose created")
  );
});
```

Console output and exit codes are valid assertions for CLI tests—that's the user interface.

### Web Routes

Test route handlers directly, mock only external services:

```typescript
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");

it("should create a run", async () => {
  mockAuth({ userId: "user-123" });

  const response = await POST(request);
  const data = await response.json();

  expect(data.status).toBe("running");
});
```

Use real database operations for verification—if you created a run, query the database to confirm it exists.

### Platform UI

Test through the same initialization flow as production:

```typescript
await setupPage({
  context,
  path: "/dashboard",
});

await user.click(screen.getByRole("button", { name: "Create" }));

expect(screen.getByText("Created successfully")).toBeInTheDocument();
```

Don't render components directly—use `setupPage()` which mirrors `main.ts` startup.

## Reference

### Deep Dives

| Topic | Guide |
|-------|-------|
| Anti-patterns | [anti-patterns.md](./testing/anti-patterns.md) — Detailed catalog of testing mistakes to avoid (AP-1 through AP-10) |
| Patterns | [patterns.md](./testing/patterns.md) — Standard patterns, file structure, migration workflow |

### App-Specific Guides

| App | Guide |
|-----|-------|
| CLI commands | [cli-testing.md](./testing/cli-testing.md) |
| CLI E2E (BATS) | [cli-e2e-testing.md](./testing/cli-e2e-testing.md) |
| Web routes | [web-testing.md](./testing/web-testing.md) |
| Platform UI | [platform-testing.md](./testing/platform-testing.md) |

For general code quality rules (no `any`, no lint suppressions, etc.), see [bad-smell.md](./bad-smell.md).
