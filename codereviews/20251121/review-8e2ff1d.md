# Review: implement VM0 system events for run lifecycle management

**Commit:** 8e2ff1d
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Sat Nov 22 22:26:50 2025 +0800

## Summary

This is a substantial commit implementing VM0 system events for run lifecycle management. It adds three new event types (vm0_start, vm0_result, vm0_error) to provide definitive run completion signals independent of agent events.

Key features:

- New VM0 event types and service for sending events
- Backend changes: send vm0_start after run status update, vm0_result/error after checkpoint
- Agent script changes: make checkpoint creation mandatory for successful runs
- CLI changes: extend event parser to handle VM0 events, update polling logic
- Environment variable expansion support in CLI build command
- Multiple refactoring passes to optimize database queries and fix memory issues

Total: ~1600 insertions across multiple modules and substantial test updates.

## Code Smell Analysis

### ✅ Good Practices

- Clear separation of concerns with new events module (events/types.ts, events/vm0-events.ts, events/index.ts)
- Fixed sequence numbers (0 for vm0_start, 1000000 for vm0_result/error) avoid database queries
- Comprehensive test suite with 176 lines in env-expander.test.ts covering edge cases
- Proper environment variable expansion support via expandEnvVars and expandEnvVarsInObject
- Test cleanup properly ordered to prevent orphaned records (delete parent first)
- Multiple iterative fixes showing commitment to quality (sequence number optimization, cascade deletes)
- Good adherence to YAGNI principle: removed cleanupServices when root cause (wrong event types) was found
- CLI polling starts from -1 to capture all events including vm0_start at sequence 0

### ⚠️ Issues Found

1. **ESLint disable comment in tests** (CRITICAL - Violates CLAUDE.md guideline)
   - File: `turbo/apps/cli/src/lib/__tests__/env-expander.test.ts` lines 450, 452, 454
   - Contains eslint-disable comments: `// eslint-disable-next-line turbo/no-undeclared-env-vars`
   - CLAUDE.md explicitly states: "Zero tolerance for lint/type suppressions - fix the issue, don't hide it"
   - Per CLAUDE.md: "Never add eslint-disable comments"
   - Status: MUST BE FIXED - This violates project standards

2. **Empty environment variable handling** (Minor - Error handling concern)
   - File: `turbo/apps/cli/src/lib/env-expander.ts` line 10
   - Returns empty string `""` when env var is undefined
   - For undefined critical vars like CI_GITHUB_TOKEN, this creates silent failures
   - Recommendation: Consider warning or error for undefined variables

3. **Type casting without validation** (Minor - Type safety concern)
   - File: `turbo/apps/cli/src/commands/run.ts` line 423
   - `event.eventData as Record<string, unknown>` - casting without validation
   - While necessary for parsing, could validate event structure first

4. **Test cleanup might still have edge cases** (Minor - Test maintenance)
   - File: Multiple test files (checkpoint, events routes)
   - Cleanup relies on cascade deletes being properly configured
   - If schema changes, tests could silently leave orphaned records
   - Recommendation: Add explicit cleanup for safety

### 💡 Recommendations

1. **CRITICAL: Remove ESLint disable comments**
   Instead of disabling the lint rule, properly declare environment variables in a constants file:

   ```typescript
   // turbo/apps/cli/src/lib/env-constants.ts
   export const TEST_TOKEN = process.env.TEST_TOKEN || "";
   export const TEST_USER = process.env.TEST_USER || "";
   export const TEST_REGION = process.env.TEST_REGION || "";
   ```

   Then use in tests without lint comments:

   ```typescript
   beforeEach(() => {
     process.env.TEST_TOKEN = "secret-token-123";
     process.env.TEST_USER = "testuser";
     process.env.TEST_REGION = "us-east-1";
   });
   ```

2. **Improve env var expansion error handling**:

   ```typescript
   export function expandEnvVars(
     value: string,
     required: string[] = [],
   ): string {
     return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
       const varValue = process.env[varName];
       if (varValue === undefined && required.includes(varName)) {
         throw new Error(`Required environment variable not set: ${varName}`);
       }
       return varValue ?? "";
     });
   }
   ```

3. **Add validation for event data structure**:
   ```typescript
   const eventData = event.eventData;
   if (typeof eventData !== "object" || eventData === null) {
     console.warn(`Invalid event data structure: ${JSON.stringify(event)}`);
     continue;
   }
   const parsed = ClaudeEventParser.parse(eventData as Record<string, unknown>);
   ```

## Breaking Changes

- **CLI polling change**: Initial sequence number changed from 0 to -1
  - This ensures vm0_start event (sequence 0) is captured on first poll
  - Applications polling manually need to be updated
- **Event type change**: Agent events no longer trigger completion
  - Only vm0_result or vm0_error trigger completion
  - Requires checkpoint creation for successful runs (introduced in 098adc6)

## Critical Issues Requiring Immediate Action

- **ESLint disable comments MUST be removed** per CLAUDE.md guidelines
- This commit violates the "Zero tolerance for lint/type suppressions" principle
