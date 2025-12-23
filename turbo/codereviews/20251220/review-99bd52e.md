# Code Review: feat: add codex support alongside claude code

**Commit:** 99bd52e4c9bf20bad9c10fbe82081bd55163c3e5
**Author:** Lancy
**Date:** 2025-12-20
**Files Changed:** 16 files (+1014/-80)

## Summary

This PR adds support for OpenAI Codex CLI alongside the existing Claude Code integration, enabling users to use `provider: codex` in their vm0.config.yaml.

## Review Findings

### ✅ Strengths

1. **Well-structured abstraction**: The event-parser-factory pattern cleanly abstracts the different event formats with auto-detection capability.

2. **Comprehensive test coverage**:
   - `codex-event-parser.test.ts`: 15 tests covering all event types
   - `event-parser-factory.test.ts`: 12 tests for factory and auto-detection
   - `run-service.test.ts`: 5 new tests for session path calculation

3. **Clean interface reuse**: `ParsedEvent` interface from `event-parser.ts` is reused by `CodexEventParser`, maintaining consistency.

4. **Proper null checks**: Both parsers handle null/undefined inputs correctly.

5. **Good documentation**: Clear JSDoc comments explaining event types and purpose.

### ⚠️ Minor Concerns

1. **Hardcoded "codex" model string** (`codex-event-parser.ts:123`):

   ```typescript
   model: "codex", // Codex doesn't include model in thread.started
   ```

   This could be misleading since users can specify different models via OPENAI_MODEL. Consider extracting from environment or marking as "unknown".

2. **Potential for duplicate events**: In `parseItemEvent`, both `item.started` and `item.completed` can emit events for the same tool operation. This is intentional but could lead to verbose output.

3. **Missing `item.updated` handling**: The code checks for `item.started` and `item.completed` but `item.updated` (defined in the type union) falls through to `null`.

### 🔍 Code Quality

| Criteria             | Status                                                         |
| -------------------- | -------------------------------------------------------------- |
| No unnecessary mocks | ✅ Uses vitest mocking appropriately                           |
| Test coverage        | ✅ Good coverage for new code                                  |
| No over-engineering  | ✅ Simple factory pattern, no premature abstractions           |
| Interface changes    | ✅ Backwards compatible - existing ClaudeEventParser unchanged |
| Error handling       | ✅ Returns null for unparseable events                         |
| Type safety          | ✅ Proper TypeScript interfaces                                |

### 📁 Files Changed

| File                      | Change Type | Notes                              |
| ------------------------- | ----------- | ---------------------------------- |
| `codex-event-parser.ts`   | New         | Core Codex event parser            |
| `event-parser-factory.ts` | New         | Factory with auto-detection        |
| `run.ts`                  | Modified    | Switch to factory pattern          |
| `run.test.ts`             | Modified    | Update mocks for factory           |
| `provider-config.ts`      | Modified    | Add "codex" provider               |
| `e2b-service.ts`          | Modified    | Set CLI_AGENT_TYPE env var         |
| `common.py.ts`            | Modified    | Add CLI_AGENT_TYPE, OPENAI_MODEL   |
| `events.py.ts`            | Modified    | Handle Codex session ID extraction |
| `run-agent.py.ts`         | Modified    | Build Codex commands               |
| `run-service.ts`          | Modified    | Codex session path calculation     |
| `vm0-codex/` templates    | New         | E2B template files                 |

## Recommendations

1. **Consider**: Adding integration test documentation for E2E testing with actual Codex CLI once template is built.

2. **Consider**: Adding a comment explaining that `item.updated` events are intentionally skipped for display purposes.

3. **Optional**: The `model: "codex"` could be changed to the actual model if available from the API response.

## Verdict

**APPROVE** ✅

This is a well-implemented feature with good test coverage. The abstractions are appropriate and the code follows existing patterns in the codebase. The minor concerns noted above are suggestions for improvement but do not block approval.
