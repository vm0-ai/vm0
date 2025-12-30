# Code Review: 75ebade

## Commit Info

- **Hash**: 75ebade
- **Message**: feat: migrate agent run events to axiom
- **Files Changed**: 4

## Summary

This commit migrates agent run events from PostgreSQL to Axiom for better observability and log analysis. It updates both the webhook (write path) and telemetry query API (read path) to use Axiom instead of PostgreSQL.

## Changes Analysis

### 1. Webhook Events Route (`apps/web/app/api/webhooks/agent/events/route.ts`)

**Change**: Removed PostgreSQL insert, added Axiom ingest

**Assessment**: ✅ Good

- Clean removal of database write operations
- Proper use of secret masking for sensitive data in events
- Good logging for debugging

### 2. Telemetry Agent Route (`apps/web/app/api/agent/runs/[id]/telemetry/agent/route.ts`)

**Change**: Replaced PostgreSQL query with Axiom APL query

**Assessment**: ✅ Good

- Proper APL query construction with runId, sequenceNumber filters
- Handles null return from Axiom gracefully (returns empty array)
- Maintains same response format for API compatibility

### 3. Test Files Updated

**Change**: Both test files updated to mock Axiom instead of PostgreSQL

**Assessment**: ✅ Good

- Clean mock setup for `queryAxiom` and `ingestToAxiom`
- Helper function `createAxiomAgentEvent` for creating test data
- Tests properly verify Axiom is called with correct parameters

## Issues Found

### Minor Issues

1. **Missing APL query parameter escaping**: The APL query constructs strings directly from `params.id` without escaping. While this ID comes from path params and should be a UUID, consider adding validation.

```typescript
// Current:
const apl = `['${dataset}']
| where runId == "${params.id}"
```

**Recommendation**: The path param is already validated by ts-rest contract as UUID, so this is acceptable.

## Overall Assessment

✅ **Approved** - Clean migration following the same pattern as telemetry migration in PR #706 and #710. The changes are well-structured and maintain API compatibility.
