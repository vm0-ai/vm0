# Review: fix: remove duplicate result event emission in agent execution

**Commit:** 3d7b336
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Sun Nov 23 14:08:16 2025 +0800

## Summary

This commit removes duplicate manual result event emissions from the `run-agent-script.ts` file. The Claude Code agent was emitting result events both manually in the shell script and through the event processing loop, causing duplicate events. The fix keeps logging and checkpoint creation intact while relying solely on Claude Code's output stream for result events.

**Changes:**

- Remove `send_event` call for success case (line 371)
- Remove `send_event` call for failure case (line 382)
- Preserve logging messages and checkpoint creation workflow
- Result events now come exclusively from Claude Code's JSONL output

**File affected:** `/workspaces/vm01/turbo/apps/web/src/lib/e2b/run-agent-script.ts` (4 lines changed, 1 insertion, 3 deletions)

## Code Smell Analysis

### ✅ Good Practices

- **Fail-fast principle**: Maintains error handling without defensive wrappers
- **Proper cleanup**: Removes unnecessary code causing duplicate events rather than adding suppressions
- **Logging preservation**: Keeps diagnostic logging intact for visibility
- **Minimal changes**: Surgical removal of problematic code with clear reasoning
- **Documentation**: Commit message clearly explains the motivation (fixing issue #159)

### ⚠️ Issues Found

**None identified.** This is a clean, minimal fix with no code smells.

The commit properly:

- Eliminates duplicate event emissions without adding try/catch blocks
- Maintains the checkpoint creation workflow for successful runs
- Preserves logging for debugging purposes
- Follows the fail-fast approach by removing unnecessary manual event handling

### 💡 Recommendations

**Suggested improvements:** None. This is a well-executed fix.

**Notes on quality:**

- The change is properly scoped to address the specific issue (duplicate events)
- No fallback patterns or defensive programming introduced
- No artificial delays or timers added
- Commit message follows conventional commit format correctly

## Breaking Changes

**None.** This is an internal fix that maintains the same result event output (just eliminating duplicates). External consumers of the result events will receive the same event structure, just with proper deduplication.
