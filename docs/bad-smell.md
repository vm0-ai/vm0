# Bad Code Smells

This document defines code quality issues and anti-patterns to identify during code reviews.

**Note**: Testing-specific patterns and anti-patterns are in `docs/testing.md`.

## 1. TypeScript `any` Type

**PROHIBITION**: Zero tolerance for `any` types.

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

## 2. Lint/Type Suppressions

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

## 3. Error Handling

- Identify unnecessary try/catch blocks
- Suggest fail-fast improvements
- Flag over-engineered error handling

## 4. Interface Changes

- Document new/modified public interfaces
- Highlight breaking changes
- Review API design decisions

## 5. Dynamic Imports

**PROHIBITION**: Zero tolerance for dynamic `import()` in production code - use static imports only.

**Prohibited patterns:**
- `await import("module")` - Use static `import` at file top instead
- `import("module").then(...)` - Use static `import` at file top instead
- Conditional imports like `if (condition) { await import(...) }` - Restructure code to use static imports

**Why dynamic imports are harmful:**
- Break tree-shaking and bundle optimization
- Add unnecessary async complexity to synchronous operations
- Make dependency analysis harder for tools
- Increase code complexity without real benefits
- Hide import errors until runtime instead of catching at build time

**Always use static imports:**
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

**Rare exceptions (must be justified):**
- Truly optional dependencies that may not exist (e.g., dev-only tools)
- Route-based code splitting in Next.js (handled by framework automatically)
- Testing utilities that need to be mocked (prefer static imports with mocking instead)

## 6. Hardcoded URLs and Configuration

- Never hardcode URLs or environment-specific values
- Use centralized configuration from `env()` function
- Avoid hardcoded fallback URLs like `"https://vm7.ai"`
- Server-side code should not use `NEXT_PUBLIC_` environment variables
- All configuration should be environment-aware

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

## 7. Fallback Patterns - Fail Fast

**PROHIBITION**: No fallback/recovery logic - errors should fail immediately and visibly.

- Fallback patterns increase complexity and hide configuration problems
- When critical dependencies are missing, throw errors instead of falling back

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

**Rationale:**
- Fallbacks make debugging harder - you don't know which path was taken
- Configuration errors should be caught during deployment, not hidden
- Explicit failures are easier to fix than subtle wrong behavior
- Less code paths = simpler code = easier to maintain
