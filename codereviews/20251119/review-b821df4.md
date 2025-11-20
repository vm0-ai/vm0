# Code Review: b821df4

**Commit**: b821df4d412da54aa880dbd98d1b57567cf1b4e0
**Title**: fix: use correct env var and auth header for webhook authentication (#80)
**Author**: Lan Chenyu
**Date**: 2025-11-19

## Overview

Implements webhook-based event streaming for agents with authentication. Adds event handler and poller modules for managing agent events.

## Files Changed

- `e2b/run-agent.sh`
- `turbo/apps/web/src/lib/e2b/e2b-service.ts`
- `turbo/packages/agent/src/event-handler.ts` (new)
- `turbo/packages/agent/src/event-poller.ts` (new)

## Bad Smell Analysis

### ❌ CRITICAL: Avoid Fallback Patterns (Bad Smell #13)

**turbo/packages/agent/src/event-handler.ts:45-52**

```typescript
// Fallback to file mode
console.warn(
  "No WEBHOOK_BASE_URL configured, falling back to file mode. " +
    "For local development, run: ./scripts/start-ngrok.sh",
);
return {
  mode: "file",
  outputFile: "/tmp/agent-events.jsonl",
};
```

**VIOLATION**: Bad smell #13 explicitly prohibits fallback patterns
- Silent fallback hides misconfiguration
- Makes debugging harder (which mode is active?)
- Configuration errors should be caught during deployment

**Required Fix**: Fail fast instead of falling back
```typescript
// Option 1: Require explicit configuration
if (!webhookBaseUrl && mode !== "file") {
  throw new Error("WEBHOOK_BASE_URL not configured for webhook mode");
}

// Option 2: Make mode selection explicit, not a fallback
const mode = process.env.EVENT_MODE || "file"; // Explicit choice
```

**Severity**: HIGH

### ❌ CRITICAL: Artificial Delays (Bad Smell #10)

**turbo/packages/agent/src/event-poller.ts:62**

```typescript
await new Promise((resolve) => setTimeout(resolve, intervalMs));
```

**VIOLATION**: Polling loop with setTimeout delays

**Problems**:
- Bad smell #10 concerns apply to production code, not just tests
- Polling with delays is inefficient
- Should use event-driven architecture instead

**Required Fix**: Use file system watchers for file mode
```typescript
// Replace polling with fs.watch()
import { watch } from "fs";

const watcher = watch(outputFile, (eventType) => {
  if (eventType === "change") {
    readNewEvents();
  }
});
```

**Severity**: HIGH

### ⚠️ ARCHITECTURAL CONCERN: Complex Abstraction

**New files**: `event-handler.ts`, `event-poller.ts`

**YAGNI Principle Violation**:
- Adds abstraction for file vs webhook modes
- Polling with delays (not event-driven)
- Fallback patterns increase complexity

**Questions**:
1. Is this abstraction needed?
2. Could webhook mode be the only mode (simpler)?
3. If file mode needed, why not use fs.watch instead of polling?

**Recommendation**: Review if these files align with YAGNI and fail-fast principles.

### ✅ PASS: Type Safety (Bad Smell #9)
- No `any` types
- Proper TypeScript types throughout

### ✅ PASS: Dynamic Imports (Bad Smell #6)
- All imports are static

### ✅ PASS: Suppressions (Bad Smell #14)
- No lint/type suppressions

## Recommendations

### 1. CRITICAL: Remove Fallback Pattern
**File**: `turbo/packages/agent/src/event-handler.ts:45-52`
**Action**: Fail fast instead of falling back to file mode
**Options**:
- Make mode selection explicit via environment variable
- Throw error if configuration is missing
- No silent fallbacks

### 2. CRITICAL: Replace Polling with Event-Driven Approach
**File**: `turbo/packages/agent/src/event-poller.ts:62`
**Action**: Use fs.watch() for file mode instead of setTimeout polling
**Benefits**:
- More efficient (no CPU waste)
- Immediate event processing
- No arbitrary delays
- Aligns with project principles

### 3. HIGH: Reconsider Architecture
**Files**: `event-handler.ts`, `event-poller.ts`
**Questions to address**:
- Can we simplify to webhook-only mode?
- Is the file/webhook abstraction needed?
- Does this follow YAGNI?

**Recommendation**: Consider removing these files if webhook mode can be the only mode.

## Overall Assessment

**Grade**: D (Needs Significant Revision)

This commit introduces two critical violations of project principles:
1. Fallback pattern (violates "fail fast")
2. Polling with delays (violates event-driven approach)

Additionally, the abstraction may violate YAGNI principle.

## Critical Issues

### Issue 1: Fallback Pattern ❌
- **Location**: event-handler.ts:45-52
- **Severity**: HIGH
- **Action**: Must fail fast, not fall back

### Issue 2: Polling with Delays ❌
- **Location**: event-poller.ts:62
- **Severity**: HIGH
- **Action**: Replace with fs.watch()

### Issue 3: YAGNI Concern ⚠️
- **Files**: Both new files
- **Severity**: MEDIUM
- **Action**: Review if abstraction is needed

## Required Actions Before Merge

1. ❌ Remove fallback pattern - make configuration explicit
2. ❌ Replace polling with fs.watch() for file mode
3. ⚠️ Justify the abstraction or simplify to webhook-only

## Impact

**Negative**: Introduces code quality issues that violate core project principles defined in CLAUDE.md and specs/bad-smell.md. Requires revision before merge.
