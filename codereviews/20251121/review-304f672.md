# Review: implement checkpoint resume functionality

**Commit:** 304f672
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Sun Nov 23 00:38:58 2025 +0800

## Summary

This comprehensive commit implements checkpoint resume functionality, enabling agents to resume execution from previously saved checkpoints. This is a multi-phase implementation with significant architectural changes.

Key features:

- Database: Add resumed_from_checkpoint_id field to agent_runs
- Service layer: Create run-service to orchestrate run and resume logic
- E2B service: Refactor to use ExecutionContext abstraction
- Volume service: Add prepareVolumesFromSnapshots for Git volume restoration
- API: Create POST /api/agent/runs/resume endpoint
- Script: Add --resume flag support to Claude Code execution
- CLI: Add `vm0 run resume <checkpointId> <prompt>` command
- E2E tests: Comprehensive test for checkpoint resume flow

Total: ~900 insertions with significant refactoring of existing code.

## Code Smell Analysis

### ✅ Good Practices

- Clear service layer abstraction with run-service.ts handling orchestration
- ExecutionContext abstraction provides clean contract between services
- Proper error handling in resume route with rollback on failure
- Session history restoration from checkpoint
- Git volume snapshots properly prepared and restored
- E2E test provides comprehensive validation of resume flow
- Multiple git-related helper functions for operations (branch, commit, push)
- Proper type definitions for ExecutionContext and related types
- Cascade delete configurations prevent orphaned records

### ⚠️ Issues Found

1. **Removed cleanupServices following YAGNI - Good decision reversal** (No action needed)
   - Commit mentions removing cleanupServices in 8e2ff1d follow-up
   - Good example of removing over-engineering when root cause was identified
   - This is proper application of YAGNI principle

2. **Service layer mocking in tests may hide integration issues** (Minor - Test coverage)
   - File: `turbo/apps/web/app/api/agent/runs/__tests__/route.test.ts`
   - Tests mock run service methods instead of testing actual service logic
   - While acceptable, integration tests should also exist
   - Recommendation: Add integration tests that verify run-service + e2b-service interaction

3. **Session history path handling** (Minor - Configuration concern)
   - File: `turbo/apps/web/src/lib/run/run-service.ts`
   - Session history path is calculated but could have path traversal issues
   - The path is derived from checkpoint which comes from database
   - Current implementation appears safe but worth noting

4. **Git snapshot restoration assumes git repository exists** (Minor - Error handling)
   - File: `turbo/apps/web/src/lib/volume/volume-service.ts` (prepareVolumesFromSnapshots)
   - If git repository structure changed since checkpoint, restoration could fail
   - Should add better error messages indicating which volume failed to prepare

5. **ExecutionContext parameter explosion** (Code smell - Parameter bloat)
   - File: `turbo/apps/web/src/lib/run/types.ts`
   - ExecutionContext is passed extensively through call chain
   - Might be worth examining in future if it grows beyond ~10 properties
   - Current implementation acceptable but monitor for future growth

### 💡 Recommendations

1. **Add integration tests for run-service**:

   ```typescript
   // turbo/apps/web/src/lib/run/__tests__/run-service.integration.test.ts
   describe("run-service integration", () => {
     it("should create run with real e2b and volume services", async () => {
       const context = await runService.createRunContext({ ... });
       const result = await runService.executeRun(context);
       expect(result).toHaveProperty("success", true);
     });
   });
   ```

2. **Improve error messages in volume preparation**:

   ```typescript
   try {
     await restoreGitSnapshot(snapshot);
   } catch (error) {
     throw new Error(
       `Failed to prepare volume "${volumeName}" from snapshot: ${error instanceof Error ? error.message : "unknown error"}`,
     );
   }
   ```

3. **Add validation for ExecutionContext in run-service**:

   ```typescript
   private validateExecutionContext(context: ExecutionContext): void {
     if (!context.runId) throw new Error("ExecutionContext missing runId");
     if (!context.agentConfig) throw new Error("ExecutionContext missing agentConfig");
     // ... validate other critical fields
   }
   ```

4. **Document the checkpoint resume flow**:
   - Add architecture documentation explaining session history restoration
   - Document Git volume snapshot and restore behavior
   - Clarify what happens if checkpoint data is partially corrupted

## Breaking Changes

- **API endpoint change**: Run API now requires run-service instead of direct e2b-service calls
  - Internal implementation change, no public API breaking changes
  - All tests updated to mock run-service
- **E2B service signature change**: createRun replaced with execute()
  - This is an internal refactoring
  - Tests updated accordingly
- **New resume endpoint**: POST /api/agent/runs/resume
  - Adds new functionality, not a breaking change
  - Requires checkpoint ID and prompt

## Architecture Notes

The ExecutionContext abstraction is a positive architectural improvement:

- Decouples run orchestration from E2B sandbox details
- Enables cleaner session history management
- Simplifies checkpoint resume implementation
- Reduces parameter passing between functions

This is a well-structured refactoring that improves testability and maintainability.
