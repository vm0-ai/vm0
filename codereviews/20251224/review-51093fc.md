# Code Review: 51093fc - feat: migrate sandbox system logs to axiom

## Summary

This commit migrates sandbox system logs from PostgreSQL to Axiom observability platform while keeping metrics and network logs in PostgreSQL. The implementation includes a new Axiom client module with singleton pattern, dataset naming helper, and updates to both the telemetry webhook and system-log API.

## Review Checklist

### 1. Mock Analysis

| Issue | Severity | Location |
|-------|----------|----------|
| Axiom module mocking in tests | Acceptable | `route.test.ts` files |

**Details:**
- Tests mock the Axiom module (`ingestToAxiom`, `queryAxiom`) - this is acceptable as it's an external service
- The mocks are properly typed and return sensible defaults
- Tests verify mock interactions appropriately

**No issues found** - Mocking external services like Axiom is appropriate.

---

### 2. Test Coverage

| Aspect | Assessment |
|--------|------------|
| System log to Axiom flow | Covered |
| Metrics to PostgreSQL flow | Covered |
| Secret masking | Covered |
| Pagination (limit/since) | Covered |
| Axiom not configured fallback | Covered |
| Multiple uploads | Covered |

**Observations:**
- Tests properly verify that systemLog goes to Axiom, not PostgreSQL
- Tests verify metrics still go to PostgreSQL
- Secret masking verification updated to check Axiom payload
- Good coverage of edge cases (null Axiom response, empty logs)

**No issues found** - Test coverage is comprehensive.

---

### 3. Error Handling

| Pattern | Location | Assessment |
|---------|----------|------------|
| Fire-and-forget with catch | `telemetry/route.ts:83-85` | Acceptable |
| Return null on failure | `axiom/client.ts:48-51, 63-66` | Acceptable |

**Details:**
- Axiom ingest uses fire-and-forget pattern with `.catch()` to not block webhook - appropriate for non-critical telemetry
- Query failures return `null` allowing graceful degradation - the API returns empty logs instead of error

**No issues found** - Error handling follows fail-graceful pattern appropriate for observability data.

---

### 4. Interface Changes

| Change | Type | Breaking? |
|--------|------|-----------|
| System logs no longer stored in PostgreSQL | Behavior | No* |
| New Axiom module exports | Addition | No |
| AXIOM_TOKEN env variable | Addition | No |

*Note: The CLI `vm0 logs --system` continues to work via the API which now queries Axiom instead of PostgreSQL. Existing data in PostgreSQL will not be accessible - this is expected migration behavior.

**No issues found** - Interface changes are additive or transparent to consumers.

---

### 5. Timer and Delay Analysis

**No timers or delays found** - All operations are synchronous or use proper async/await.

---

### 6. Dynamic Imports

**No dynamic imports found** - All imports are static at file top.

---

### 7. Database Mocking

| Issue | Severity | Details |
|-------|----------|---------|
| None | N/A | Tests use real database for PostgreSQL operations |

**No issues found** - Database operations continue to use real connections.

---

### 8. Test Mock Cleanup

| File | `vi.clearAllMocks()` in beforeEach? |
|------|-------------------------------------|
| system-log route.test.ts | Yes (line 74) |
| telemetry route.test.ts | Yes (existing) |

**No issues found** - Mock cleanup is properly implemented.

---

### 9. TypeScript `any` Usage

**No `any` types found** - All types are properly defined:
- `AxiomSystemLogEvent` interface for Axiom query results
- Generic `<T>` parameter in `queryAxiom<T>()`
- `Entry` type imported from `@axiomhq/js`

---

### 10. Artificial Delays

**No artificial delays found** - No `setTimeout`, `vi.useFakeTimers`, or similar.

---

### 11. Hardcoded URLs/Configuration

| Pattern | Location | Assessment |
|---------|----------|------------|
| Dataset prefix `vm0-` | `datasets.ts:9` | Acceptable |
| Environment check `VERCEL_ENV` | `datasets.ts:8` | Acceptable |

**No issues found** - Configuration uses environment variables appropriately.

---

### 12. Direct Database Operations in Tests

Tests continue to use direct database operations for setup/cleanup, but this is consistent with existing test patterns in the codebase and appropriate for unit tests that need specific data states.

---

### 13. Fallback Patterns

| Pattern | Location | Assessment |
|---------|----------|------------|
| Return `null` if AXIOM_TOKEN missing | `client.ts:14-17` | Acceptable |
| Return empty logs if Axiom not configured | `route.ts:65-71` | Acceptable |

**Assessment:** These are graceful degradation patterns, not silent fallbacks that hide configuration errors. The system continues to function without Axiom (just with no system logs), and debug logs indicate when Axiom is not configured.

---

### 14. Lint/Type Suppressions

**No suppression comments found** - Code passes all lint rules.

---

### 15. Test Quality

| Pattern | Found? | Details |
|---------|--------|---------|
| Fake tests | No | Tests verify actual behavior |
| Over-mocking | No | Only external service mocked |
| Over-testing error responses | No | - |
| Console mocking without assertions | No | - |

**No issues found** - Tests are meaningful and test actual behavior.

---

## Potential Improvements (Optional)

1. **APL Injection Risk**: The `params.id` is inserted directly into the APL query string. While it's a UUID validated by the route, consider using parameterized queries if Axiom supports them.

   ```typescript
   // Current (line 56-60 in route.ts):
   const apl = `['${dataset}']
   | where runId == "${params.id}"
   ...`;
   ```

2. **Dataset Creation**: The code assumes Axiom datasets exist. Consider documenting the required dataset setup or adding dataset auto-creation logic.

---

## Conclusion

**Overall Assessment: APPROVED**

This is a clean, well-structured migration that:
- Follows project patterns and principles
- Maintains backward compatibility for CLI users
- Has comprehensive test coverage
- Uses appropriate error handling for observability data
- Does not introduce any bad code smells

The implementation is production-ready.
