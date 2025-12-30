# Code Review: f9c42b2

**Commit:** feat(cli): replace --limit with --tail and --head flags for logs command

## Summary

This commit implements a breaking change to the `vm0 logs` command, replacing the ambiguous `--limit` flag with explicit `--tail` and `--head` flags that match industry conventions (docker logs, kubectl logs, Linux tail/head).

## Files Changed

| File | Type | Description |
|------|------|-------------|
| `packages/core/src/contracts/runs.ts` | Contract | Add `order` parameter to 4 telemetry schemas |
| `apps/web/app/api/agent/runs/[id]/telemetry/*/route.ts` | Server | Use dynamic order in APL queries (4 files) |
| `apps/cli/src/lib/api-client.ts` | Client | Pass `order` parameter to telemetry methods |
| `apps/cli/src/commands/logs/index.ts` | CLI | Replace `--limit` with `--tail`/`--head`, add reversal logic |

## Review Against Bad Code Smells

### 1. Mock Analysis
- **No new mocks introduced** - Changes are to production code only

### 2. Test Coverage
- **No new tests added in this commit** - E2E tests updated in follow-up commit
- Unit tests pass (1196 tests)

### 3. Error Handling
- **Good** - Mutual exclusivity check exits with clear error message
- **No unnecessary try/catch blocks** - Error handling is appropriate

### 4. Interface Changes
- **Breaking change** - `--limit` removed, replaced with `--tail`/`--head`
- **API backward compatible** - Server still accepts `limit` parameter, adds optional `order` parameter
- **Well-documented** - Commit message clearly explains the change

### 5. Timer and Delay Analysis
- **No timers or delays** - Not applicable

### 6. Dynamic Imports
- **No dynamic imports** - Clean static imports throughout

### 7. Database/Service Mocking
- **Not applicable** - No tests in this commit

### 8. Test Mock Cleanup
- **Not applicable** - No tests in this commit

### 9. TypeScript `any` Usage
- **No `any` types** - Proper typing with `"asc" | "desc"` union type

### 10. Artificial Delays
- **None** - Not applicable

### 11. Hardcoded URLs
- **None** - Configuration uses proper env handling

### 12. Direct Database Operations
- **Not applicable** - No test changes

### 13. Fallback Patterns
- **Good** - Default values are explicit in Zod schema (`.default("desc")`)

### 14. Lint/Type Suppressions
- **None** - No suppression comments

### 15. Bad Tests
- **Not applicable** - No tests in this commit

## Code Quality Assessment

### Strengths

1. **Clean API design** - Adding `order` parameter to API is a good abstraction
2. **Proper reversal logic** - CLI correctly reverses tail results for chronological display
3. **Industry alignment** - Matches `docker logs --tail` behavior
4. **Type safety** - Proper TypeScript typing with union types

### Potential Concerns

1. **APL injection risk** - The `order` variable is interpolated directly into APL query:
   ```typescript
   | order by _time ${order}
   ```
   However, the Zod schema validates `order` as `z.enum(["asc", "desc"])`, so only `asc` or `desc` can pass through, mitigating injection risk.

2. **Breaking change** - Users relying on `--limit` will need to update their scripts. This is acceptable given it aligns with industry standards.

## Verdict

**APPROVED** - Clean implementation with proper typing, no code smells detected.
