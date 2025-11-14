# Bad Code Smells

This document defines code quality issues and anti-patterns to identify during code reviews.

## 1. Mock Analysis
- Identify new mock implementations
- Suggest non-mock alternatives where possible
- List all new mocks for user review
- Flag fetch API mocking in tests (should use MSW for network mocking instead)

## 2. Test Coverage
- Evaluate test quality and completeness
- Check for missing test scenarios
- Assess test maintainability

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
- Avoid hardcoded fallback URLs like `"https://uspark.dev"`
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

