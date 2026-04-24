# Review Instructions

## Review Verdict

**Reject** the PR if it contains any Important finding. **Approve** only when there are zero Important findings. Nits do not block approval.

## Severity Definitions

- **Important** — Must fix before merge. Bugs that break behavior, leak data, block rollback, or violate zero-tolerance rules (see below).
- **Nit** — Minor issues worth fixing but not merge-blocking.
- **Pre-existing** — Bugs in the codebase not introduced by this PR. Do not count toward the verdict.

## Cap the Nits

Report at most 5 nits per review. If more are found, say "plus N similar items" in the summary.

---

## Zero-Tolerance Rules (Always Important)

### ZT-1: No `any` type

Flag all `any` type usage. Use `unknown` with type narrowing or define proper interfaces instead.

```typescript
// BAD
const data: any = fetchData();

// GOOD
const data: unknown = fetchData();
if (isValidData(data)) { /* use data with proper type */ }
```

### ZT-2: No lint/type suppressions

Flag all suppression comments. Always fix the root cause.

Prohibited comments:
- `eslint-disable`, `oxlint-disable`
- `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`
- `prettier-ignore`

Prohibited plugins: `eslint-plugin-only-warn`

### ZT-3: No dynamic imports in production code

Flag `await import()` and `import().then()`. Use static imports at file top.

```typescript
// BAD
async function generateToken() {
  const crypto = await import("crypto");
  return crypto.randomBytes(32).toString("base64url");
}

// GOOD
import { randomBytes } from "crypto";
function generateToken() {
  return randomBytes(32).toString("base64url");
}
```

Rare exceptions: truly optional dev-only dependencies, Next.js route-based code splitting (handled by framework).

---

## Architectural Principles

### ARCH-1: Fail fast, no defensive programming

Only catch exceptions when there is **meaningful recovery logic** (rollback, cleanup, retry, per-item error handling in loops, security-critical code).

Flag these bad patterns:

**Pattern A — Log + return generic error:**
```typescript
// BAD
try { /* logic */ } catch (error) {
  log.error("...", error);
  return { status: 500, body: { error: { message: "Internal server error" } } };
}
```

**Pattern B — Silent failure:**
```typescript
// BAD
try { /* logic */ } catch (error) {
  console.error("...", error);
  return null;
}
```

**Pattern C — Log and re-throw without recovery:**
```typescript
// BAD
try { /* logic */ } catch (error) {
  log.error("...", error);
  throw error;
}
```

### ARCH-2: No fallback patterns

Flag fallback/recovery logic that hides configuration problems. Errors should fail immediately and visibly.

```typescript
// BAD — fallback hides misconfiguration
const jwtSecret = process.env.JWT_SECRET || process.env.SOME_OTHER_SECRET || "default-secret";

// GOOD — fail fast with clear error
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error("JWT_SECRET not configured");
```

### ARCH-3: No hardcoded URLs or configuration

- Flag hardcoded URLs and environment-specific values
- Verify usage of `env()` configuration function
- Server-side code should not use `NEXT_PUBLIC_` environment variables
- Never use hardcoded fallback URLs like `"https://vm7.ai"`

```typescript
// BAD
const apiUrl = process.env.API_URL || "https://api.vm7.ai";

// GOOD
const apiUrl = env().API_URL;
```

### ARCH-4: YAGNI (You Aren't Gonna Need It)

- Flag premature abstractions and over-engineering
- Flag "just in case" parameters or options
- Flag utility functions for single use cases
- Flag code that adds functionality not yet needed

---

## Testing Anti-Patterns (Always Flag)

This project follows **"Write tests. Not too many. Mostly integration."** Integration tests are the primary test type. Unit tests are not written (with narrow exceptions for security-critical, algorithmically complex, or state-machine transition code).

### AP-1: Testing mock calls instead of behavior

```typescript
// BAD — proves nothing
it("should call getUser", async () => {
  await someFunction();
  expect(mockGetUser).toHaveBeenCalled();
});

// GOOD — verifies behavior
it("should retrieve and display user data", async () => {
  const result = await someFunction();
  expect(result.userName).toBe("expected-name");
});
```

If you see `toHaveBeenCalled()` without behavior assertions, flag it.

### AP-2: Direct fetch mocking

```typescript
// BAD — brittle and unrealistic
vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));

// GOOD — use MSW
server.use(
  http.get("https://api.example.com/users", () => {
    return HttpResponse.json({ users: [{ id: 1, name: "Test" }] });
  }),
);
```

MSW intercepts at the network level and tests actual request construction (URL building, headers, body formatting).

### AP-3: Filesystem mocking

```typescript
// BAD
vi.mock("fs");
vi.mock("fs/promises");

// GOOD — use real filesystem with temp directories
let tempDir: string;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "test-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });
```

Real filesystem catches permission issues, race conditions, and encoding problems that mocks hide.

### AP-4: Mocking internal code (highest priority)

**The Relative Path Rule**: If the path in `vi.mock()` starts with `../` or `../../`, it's wrong.

```typescript
// BAD — internal code
vi.mock("../../services/user-service");
vi.mock("../../lib/something");

// GOOD — only external third-party packages
vi.mock("@clerk/nextjs");
vi.mock("@aws-sdk/client-s3");
```

Also flag:
- Mocking `globalThis.services.db` — always use real database
- Partial mocks with `vi.importActual()` — use real implementation

**Mock hierarchy:**
| Category | Example | Mock? |
|---|---|---|
| Third-party SaaS | `@clerk/nextjs`, `@aws-sdk/client-s3` | Yes |
| Node.js built-ins | `child_process` | Sometimes |
| Database | `globalThis.services.db` | Never |
| Internal services | `../../lib/*` | Never |
| Internal utilities | `../../utils/*` | Never |

### AP-5: Fake timers

```typescript
// BAD — masks race conditions
vi.useFakeTimers();
vi.advanceTimersByTime(1000);

// GOOD — mock only what you need
vi.spyOn(Date, "now").mockReturnValue(fixedTimestamp);
```

### AP-6: Partial internal mocks

Flag `vi.importActual()` combined with selective function replacement. Use real implementations.

### AP-7: Testing implementation details

Flag tests that verify:
- Internal function calls instead of outcomes
- CSS classes or DOM structure
- Internal component state
- Keyboard handler specifics

Test what users see instead.

### AP-8: Over-testing

Flag tests for:
- Every HTTP error status code (401, 403, 404, 400, 500...)
- Schema validation (trust Zod)
- Loading spinners and trivial UI states
- Exact UI text content

Focus on business logic and integration points.

### AP-9: Console mocking without assertions

If `console.log` or `console.error` is mocked but never asserted on, flag it — it just suppresses useful debugging output.

### AP-10: Direct component rendering (platform app)

```typescript
// BAD — doesn't match production
render(<StoreProvider value={store}><MyPage /></StoreProvider>);

// GOOD — use production initialization flow
await setupPage({ context, path: "/my-page" });
```

`setupPage()` mirrors `main.ts` bootstrap and catches initialization bugs.

### AP-11: Testing service functions when a route exists

When an API route wraps a service function, test through the route, not the service directly.

```typescript
// BAD — bypasses auth, validation, request handling
const result = await upsertOrgModelProvider(orgId, "anthropic-api-key", "sk-test");

// GOOD — test through route handler
const request = createTestRequest(url, {
  method: "POST",
  body: JSON.stringify({ type: "anthropic-api-key", secret: "sk-test" }),
});
const response = await POST(request);
```

### AP-12: Unit tests for internal functions

Flag test files that directly import and test internal/private functions. Tests should only exercise public entry points (API routes, CLI commands, exported module interfaces). Internal logic is covered through integration tests.

Narrow exceptions: security-critical code, algorithmically complex code with non-obvious invariants, state-machine transition matrices.

---

## Do Not Report

- Generated files under `src/gen/` and any `*.lock` file
- Anything CI already enforces (lint, formatting, type errors)
- Style preferences already handled by Prettier/ESLint

## Always Check

- New API routes have integration tests
- Log lines don't include email addresses or user IDs (PII)
- Database queries are scoped to the caller's tenant
- Mock cleanup with `vi.clearAllMocks()` in `beforeEach` hooks
- Breaking changes to public interfaces are documented
- Test initialization mirrors production flow
