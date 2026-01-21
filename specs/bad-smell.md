# Bad Code Smells

This document defines non-testing code quality issues and anti-patterns to identify during code reviews.

**Note**: All testing-related guidance has been consolidated into `.claude/skills/testing/SKILL.md`.

## 3. Error Handling
- Identify unnecessary try/catch blocks
- Suggest fail-fast improvements
- Flag over-engineered error handling

## 4. Interface Changes
- Document new/modified public interfaces
- Highlight breaking changes
- Review API design decisions

## 5. Prohibition of Dynamic Imports
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

## 6. Hardcoded URLs and Configuration
- Never hardcode URLs or environment-specific values
- Use centralized configuration from `env()` function
- Avoid hardcoded fallback URLs like `"https://vm7.ai"`
- Server-side code should not use `NEXT_PUBLIC_` environment variables
- All configuration should be environment-aware

## 7. Avoid Fallback Patterns - Fail Fast
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

