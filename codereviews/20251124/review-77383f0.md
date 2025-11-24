# Review: feat: enable runtime script transfer for dynamic agent execution (#139)

**Commit:** 77383f0
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Fri Nov 21 18:29:05 2025 +0800

## Summary

This commit refactors the E2B agent execution to transfer the `run-agent.sh` script at runtime instead of baking it into the template. This enables dynamic script updates without requiring template rebuilds.

Key changes:

- Move script from `/e2b/run-agent.sh` to embedded content in `turbo/apps/web/src/lib/e2b/run-agent-script.ts`
- Update E2B service to upload script at runtime
- Remove E2B template directory (now handled at runtime)
- Update GitHub Actions workflow to trigger only on `template.ts` changes
- Add workflow_dispatch for manual CLI E2E test triggers
- Update tests to reflect runtime script upload behavior
- Remove debug hint from CLI timeout error

## Code Smell Analysis

### ✅ Good Practices

- Removes infrastructure rebuild dependency for script changes
- Embedded script content eliminates file path resolution issues
- Proper error handling with meaningful error messages
- Clean separation of concerns (script content vs. service logic)
- Test cleanup with `vi.clearAllMocks()` in `beforeEach`
- Good documentation of the change rationale
- Workflow improvements targeting only necessary files for rebuilds

### ⚠️ Issues Found

#### 1. **String Escaping Complexity in Embedded Script** (Error Handling Risk)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/run-agent-script.ts`
- **Lines:** All lines
- **Issue:** The script content is embedded as a backtick template string with manual escape sequences. Uses `\\` for shell escapes, which is fragile and difficult to maintain.
- **Problem:**
  - Hard to read and modify
  - Easy to introduce bugs when updating script
  - Escaping rules differ between shell and JavaScript templates
  - Any change requires careful escape validation
- **Example problematic lines:**
  ```typescript
  local payload=$(jq -n \\      // Double backslash makes this hard to read
    --arg rid "$RUN_ID" \\
    --argjson event "$event_json" \\
    '{runId: $rid, events: [$event]}')`
  ```
- **Recommendation:** Consider storing script in a `.sh` file and importing as binary, or using a template literal processor

#### 2. **Buffer Conversion Complexity in uploadRunAgentScript()** (Over-engineering)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/e2b-service.ts`
- **Lines:** 290-300
- **Issue:** Complex ArrayBuffer conversion for a string:
  ```typescript
  const scriptBuffer = Buffer.from(RUN_AGENT_SCRIPT, "utf-8");
  const arrayBuffer = scriptBuffer.buffer.slice(
    scriptBuffer.byteOffset,
    scriptBuffer.byteOffset + scriptBuffer.byteLength,
  ) as ArrayBuffer;
  ```
- **Problem:** This is unnecessarily complex and not well documented. Could be simplified.
- **Recommendation:** Check E2B API documentation for simpler string-to-ArrayBuffer conversion method, or add explanatory comment

#### 3. **Timing Assumption in Test** (Test Anti-pattern)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/__tests__/e2b-service.test.ts`
- **Line:** 86
- **Issue:** Changed assertion from `toBeGreaterThan(0)` to `toBeGreaterThanOrEqual(0)` suggesting execution could complete in 0ms
- **Problem:** This is masking potential issues. Mock tests that complete in 0ms don't validate real timing behavior.
- **Real impact:** Low (this is a unit test with mocks), but indicates the test may not be meaningful

#### 4. **Mock fs Module but Don't Use It** (Unused Code)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/__tests__/e2b-service.test.ts`
- **Lines:** 12-15
- **Issue:**
  ```typescript
  vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      promises: {
        ...actual.promises,
        readFile: vi.fn().mockResolvedValue(...),
      },
    };
  });
  ```
- **Problem:** The mocked `fs` module is never actually used in the tests. The script content is now embedded, so this mock is dead code.
- **Recommendation:** Remove this unused mock

#### 5. **Test Assertion Logic Complexity** (Bad Tests)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/__tests__/e2b-service.test.ts`
- **Lines:** 265-270 and 313-318
- **Issue:** Tests now search for specific command call instead of verifying the first call:
  ```typescript
  const commandCall = mockSandbox.commands.run.mock.calls.find(
    (call) => call[0] === "/usr/local/bin/run-agent.sh",
  );
  ```
- **Problem:** This makes tests brittle and less clear about expectations. The test is now assuming implementation details (the order of commands).
- **Better approach:** Mock sandbox should have structured calls that are easier to assert on

#### 6. **Implicit Test Behavior Changes** (Documentation Issue)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/__tests__/e2b-service.test.ts`
- **Lines:** 77, 140, 171, 202
- **Issue:** Comments now say "commands.run called twice" but the test assertions still use `toHaveBeenCalled()` without strict count assertions
- **Problem:** Makes it unclear what the test is actually verifying
- **Recommendation:** Add explicit `toHaveBeenCalledTimes(2)` assertions after the find operation

#### 7. **Missing Error Case Coverage** (Test Coverage)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/e2b-service.ts`
- **Lines:** 301-313 (uploadRunAgentScript error handling)
- **Issue:** New error handling for script upload isn't tested
- **Recommendation:** Add test cases for:
  - Failed script file write
  - Failed script move/chmod command
  - Sandbox.files.write() throwing error

#### 8. **CLI Error Message Reduction** (Design Decision - Questionable)

- **File:** `/workspaces/vm01/turbo/apps/cli/src/commands/run.ts`
- **Lines:** Removed lines 41-45
- **Issue:** Removed helpful debug message about webhook configuration
  ```typescript
  // REMOVED:
  console.error(
    chalk.gray(
      "  This usually means the agent's webhook configuration is incorrect or unreachable",
    ),
  );
  ```
- **Problem:** This was useful debugging information for users. Removal reduces helpfulness.
- **Context:** Commit message says "Remove debug hint from CLI timeout error message" but this looks like a reduction in helpful output
- **Recommendation:** Consider keeping this as it helps users diagnose issues

#### 9. **GitHub Actions Conditional Logic** (Configuration Complexity)

- **File:** `.github/workflows/turbo.yml`
- **Lines:** 32-45
- **Issue:** New conditional logic for `workflow_dispatch` input:
  ```bash
  if [ "${{ github.event_name }}" = "workflow_dispatch" ] && [ "${{ github.event.inputs.run_cli_e2e }}" = "true" ]; then
    echo "web-changed=true" >> $GITHUB_OUTPUT
    echo "docs-changed=false" >> $GITHUB_OUTPUT
    echo "cli-changed=true" >> $GITHUB_OUTPUT
    exit 0
  fi
  ```
- **Problem:** Manual override flags both web and CLI as changed, which could trigger unnecessary work
- **Recommendation:** Document when this workflow_dispatch option should be used

#### 10. **Test Mock Cleanup - Not Explicitly Called** (Test Quality)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/__tests__/e2b-service.test.ts`
- **Line:** 18
- **Issue:** `vi.clearAllMocks()` is called in `beforeEach`, which is correct per guidelines
- **Good:** This follows the project standard properly

### 💡 Recommendations

1. **Simplify script embedding:**
   - Consider using base64 encoding if file storage is not an option
   - Or explore if E2B SDK has a cleaner way to handle embedded scripts
   - Add documentation explaining the escaping strategy

2. **Improve buffer conversion clarity:**

   ```typescript
   // Before
   const arrayBuffer = scriptBuffer.buffer.slice(...)

   // After (if E2B API allows)
   const arrayBuffer = new TextEncoder().encode(RUN_AGENT_SCRIPT);
   ```

3. **Remove dead code:**
   - Delete the unused `fs` mock from tests
   - Verify all other mocks are actually used

4. **Strengthen test assertions:**
   - Add explicit call counts where runtime script upload occurs
   - Add test cases for error scenarios in `uploadRunAgentScript`
   - Clarify what each assertion verifies

5. **Reconsider error message removal:**
   - Restore the webhook configuration hint or provide alternative debugging guidance
   - Users need help understanding timeout causes

6. **Document workflow_dispatch usage:**
   - Add comments explaining when to use the manual CLI E2E trigger
   - Add documentation for users on running tests manually

## Breaking Changes

- None for API. Internal change to script delivery mechanism.
- E2B template structure changed (no longer includes script), but E2B rebuilds typically isolate this.

## Code Quality Score: 7.5/10

**Strengths:** Solves the core problem elegantly, good test coverage, proper error handling, workflow improvements
**Weaknesses:** String escaping complexity, unused mock code, missing error test cases, test assertion clarity, helpful error message removal
