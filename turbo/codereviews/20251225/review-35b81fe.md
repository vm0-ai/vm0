# Code Review: 35b81fe

## Commit Info

- **Hash**: 35b81fe
- **Message**: fix: use client-provided sequence numbers for agent events
- **Files Changed**: 5

## Summary

This commit fixes a critical issue where the server was generating sequence numbers (index + 1) instead of using the client-provided sequence numbers. This caused issues when the sandbox sent events in batches or out of order.

## Changes Analysis

### 1. Webhook Events Route (`apps/web/app/api/webhooks/agent/events/route.ts`)

**Change**: Use `event.sequenceNumber` instead of `index + 1`

```typescript
// Before:
const axiomEvents = body.events.map((event, index) => ({
  sequenceNumber: index + 1,
  ...
}));

// After:
const axiomEvents = body.events.map((event) => ({
  sequenceNumber: event.sequenceNumber,
  ...
}));
```

**Assessment**: ✅ Critical fix

- The sandbox maintains its own sequence counter for the entire run
- Server-side index would reset on each batch, causing duplicate/incorrect sequence numbers
- Now properly preserves the client's sequence ordering

### 2. Python Script Updates (`scripts/lib/events.py.ts` and `run-agent.py.ts`)

**Change**: Added `sequence_number` parameter to `send_event()` function

```python
# Counter maintained in run-agent.py
event_sequence = 0

# Incremented for each event
event_sequence += 1
send_event(event, event_sequence)
```

**Assessment**: ✅ Good design

- Sequence counter is maintained by the Python script (single source of truth)
- Each event gets a unique, monotonically increasing sequence number
- The sequence number is added to the event payload before sending

### 3. Test Updates

**Change**: All test events now include `sequenceNumber` field

**Assessment**: ✅ Properly updated

- Tests now accurately reflect the contract requirements
- Verifies Axiom receives client-provided sequence numbers

## Issues Found

### None

This is a critical bug fix with clean implementation.

## Overall Assessment

✅ **Approved** - Properly fixes the sequence number handling. The client (sandbox Python script) is the single source of truth for sequence numbers, and the server now respects these values.
