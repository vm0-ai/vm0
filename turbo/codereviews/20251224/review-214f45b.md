# Code Review: 214f45b

## Commit Details

- **Commit**: `214f45bb80a490cd7a4a8e0fc8374f9bf845fcba`
- **Message**: feat: migrate sandbox telemetry metrics and network logs to axiom
- **Files Changed**: 6

## Summary

This commit migrates sandbox telemetry metrics and network logs from PostgreSQL to Axiom, completing the telemetry migration started in PR #706 (system logs).

## Review Criteria Analysis

### 1. New Mocks and Alternatives

**Found**: Tests correctly mock `queryAxiom` and `ingestToAxiom` from the axiom module.

```typescript
vi.mock("../../../../../../../../src/lib/axiom", () => ({
  queryAxiom: vi.fn(),
  getDatasetName: vi.fn((base: string) => `vm0-${base}-dev`),
  DATASETS: {
    SANDBOX_TELEMETRY_METRICS: "sandbox-telemetry-metrics",
  },
}));
```

**Assessment**: ✅ Good - Mocks are appropriately scoped and follow existing patterns established in PR #706.

### 2. Test Coverage Quality

**Assessment**: ✅ Good

- Tests cover authentication, authorization, basic retrieval, multiple records, pagination (limit/hasMore), and since filter
- Network logs tests are comprehensive (489 lines) and cover all major scenarios
- Tests verify APL query structure with `expect.stringContaining()` assertions
- Edge cases covered: empty results, Axiom not configured (returns null)

### 3. Unnecessary Try/Catch Blocks and Over-Engineering

**Assessment**: ✅ Good - No unnecessary try/catch blocks

The webhook uses fire-and-forget pattern correctly:

```typescript
ingestToAxiom(axiomDataset, axiomEvents).catch((err) => {
  log.error("Axiom metrics ingest failed:", err);
});
```

This is appropriate - telemetry failures shouldn't block the webhook response.

### 4. Key Interface Changes

**Assessment**: ✅ Good - API contract preserved

- Response format unchanged for both metrics and network APIs
- Metrics still returns: `{ metrics: [...], hasMore: boolean }`
- Network logs still returns: `{ networkLogs: [...], hasMore: boolean }`
- Field mappings are correct (`_time` → `ts` for metrics, `_time` → `timestamp` for network)

### 5. Timer and Delay Usage Patterns

**Assessment**: ✅ N/A - No timers or delays in this change

### 6. Dynamic Import Patterns

**Assessment**: ✅ N/A - No dynamic imports in this change

## Potential Issues

### Minor: APL Query String Interpolation

The APL queries use string interpolation:

```typescript
const apl = `['${dataset}']
| where runId == "${params.id}"
${sinceFilter}
| order by _time asc
| limit ${limit + 1}`;
```

**Risk**: Low - `params.id` is validated as UUID by ts-rest contract, and `dataset` comes from constants.

**Recommendation**: Consider using parameterized queries if Axiom SDK supports them in the future.

### Minor: Secret Masking Applied Before Axiom Ingest

```typescript
const maskedNetworkLogs = masker.mask(
  body.networkLogs,
) as typeof body.networkLogs;
```

**Assessment**: ✅ Good - Secrets are correctly masked before being sent to Axiom, preventing credential leakage in logs.

## Architecture Assessment

### Consistency

- Follows the exact pattern established in PR #706 for system logs
- Uses same fire-and-forget ingest pattern
- Uses same APL query structure

### Data Flow

```
Sandbox → Webhook → Axiom (ingest)
CLI → API → Axiom (query) → CLI
```

### PostgreSQL Removal

- `sandboxTelemetry` schema import removed from both metrics and network routes
- No more PostgreSQL inserts for metrics/network data
- All telemetry now exclusively in Axiom

## Verdict

**✅ APPROVED**

This is a clean, well-tested migration that:

1. Follows established patterns from PR #706
2. Maintains API compatibility
3. Has comprehensive test coverage
4. Correctly handles edge cases
5. Applies secret masking appropriately

No blocking issues found.
