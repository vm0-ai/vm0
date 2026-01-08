# Clean Defensive Try-Catch Blocks

Automatically find and remove defensive try-catch blocks that violate the project's "Avoid Defensive Programming" principle.

## Workflow

Execute the following steps in order:

### Step 1: Search for Removable Try-Catch Blocks

Use the Explore agent to find try-catch blocks in the codebase that match these **BAD** patterns:

**Pattern A: Log + Return Generic Error**
```typescript
try {
  // ... business logic
} catch (error) {
  log.error("...", error);
  return { status: 500, body: { error: { message: "Internal server error" } } };
}
```

**Pattern B: Silent Failure (return null/undefined)**
```typescript
try {
  // ... logic
} catch (error) {
  console.error("...", error);
  return null;
}
```

**Pattern C: Log and Re-throw Without Recovery**
```typescript
try {
  // ... logic
} catch (error) {
  log.error("...", error);
  throw error;
}
```

**DO NOT remove** try-catch blocks that have:
- Meaningful error recovery logic (rollback, cleanup, retry)
- Error type categorization (converting domain errors to HTTP responses)
- Fire-and-forget patterns for non-critical operations (e.g., analytics)
- Per-item error handling in loops (continue processing other items)
- Security-critical code where defensive programming is justified

Search in: `turbo/` directory (all packages and apps)
Target: Find up to 10 removable try-catch blocks

### Step 2: Validate Safety

For each identified try-catch block, verify:

1. **No side effects in catch block** - The catch block only logs and returns/throws
2. **Framework handles errors** - The route/function has a global error handler
3. **No cleanup logic** - No resource cleanup (DB rollback, file handles, etc.)
4. **No recovery logic** - No retry, fallback, or degradation logic
5. **Not security-critical** - Not auth/crypto code where defensive handling is appropriate

Create a table summarizing findings:
| File | Lines | Pattern | Safe to Remove | Reason |
|------|-------|---------|----------------|--------|

### Step 3: Modify Code

For each validated catch block:

1. Remove the try-catch wrapper
2. Update return types if they change (e.g., `Promise<T | null>` → `Promise<T>`)
3. Remove unused imports (e.g., `logger` if no longer used)
4. Update callers if needed (e.g., remove null filtering from `Promise.all` results)

Run verification:
```bash
cd turbo && pnpm turbo run lint
cd turbo && pnpm check-types
```

### Step 4: Create Pull Request

1. Create a feature branch: `refactor/clean-defensive-catch-<date>`
2. Commit with conventional commit message (scope based on affected packages):
   ```
   refactor(<scope>): remove defensive try-catch blocks

   Remove defensive try-catch blocks that violate the project's "Avoid
   Defensive Programming" principle.

   Files modified:
   - [list files]

   Errors now propagate to framework error handlers instead of being
   caught and logged defensively.
   ```

   Scope examples: `web`, `cli`, `core`, `runner`, or omit if multiple packages
3. Push and create PR with summary table

### Step 5: Wait for CI

Monitor CI pipeline:
```bash
gh pr checks <PR_NUMBER> --watch --interval 20
```

If CI fails:
- Check if failure is related to the changes
- If related: fix and push
- If unrelated (flaky test): note in report and retry

### Step 6: Code Review

Execute `/code-review <PR_NUMBER>` to generate detailed review.

Post review summary as PR comment.

### Step 7: Report to User

Provide a summary report:

```markdown
## Clean Catch Summary

### Files Modified
| File | Changes | Pattern Removed |
|------|---------|-----------------|
| ... | ... | ... |

### CI Status
- Lint: [PASS/FAIL]
- Type-check: [PASS/FAIL]
- Tests: [PASS/FAIL]
- E2E: [PASS/FAIL]

### PR Link
https://github.com/...

### Code Review
[Summary of review findings]

### Next Steps
- [ ] Merge PR (if approved)
- [ ] Address review comments (if any)
```

## Reference

This command follows the project's "Avoid Defensive Programming" principle from CLAUDE.md:

> - Only catch exceptions when you can meaningfully handle them
> - Let errors bubble up to where they can be properly addressed
> - Avoid defensive try/catch blocks that just log and re-throw
> - Trust the runtime and framework error handling
