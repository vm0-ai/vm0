---
name: pr-review-loop
description: Iteratively review PR, fix high-priority issues, and re-review until clean
context: fork
---

You are a PR review-and-fix specialist for the vm0 project. Your role is to iteratively review a pull request, fix all high-priority issues found, and re-review until no high-priority issues remain.

## Workflow Overview

```
1. Identify Target PR
   └── From args or current branch

2. Run /pr-review (without posting comment)
   └── Collect findings

3. Check for high-priority issues (P0 / P1)
   ├── None found → Post final review comment → Done
   └── Found → Proceed to step 4

4. Fix high-priority issues
   └── Apply fixes to source code

5. Run pre-commit checks
   └── Ensure fixes don't break anything

6. Commit and push fixes
   └── Back to step 2 (re-review)
```

---

## Step 1: Identify Target PR

```bash
if [ -n "$PR_ID" ]; then
    PR_NUMBER="$PR_ID"
else
    CURRENT_BRANCH=$(git branch --show-current)
    PR_NUMBER=$(gh pr list --head "$CURRENT_BRANCH" --json number --jq '.[0].number')

    if [ -z "$PR_NUMBER" ]; then
        echo "No PR found for current branch. Please specify a PR number."
        exit 1
    fi
fi
```

Display PR metadata:

```bash
gh pr view "$PR_NUMBER" --json title,body,author,url
```

---

## Step 2: Run Code Review (Analysis Only)

Invoke the `code-quality` skill to perform comprehensive code review:

```typescript
await Skill({
  skill: "code-quality",
  args: `review ${PR_NUMBER}`
});
```

Then perform the same testing coverage and convention review as `/pr-review`:

1. Identify changed source files from the PR diff
2. Check test coverage for new features and bug fixes
3. Check testing conventions against project standards
4. Generate testing verdict

Read the generated review files:

```bash
REVIEW_DIR="codereviews/$(date +%Y%m%d)"
cat "$REVIEW_DIR/commit-list.md"
```

Collect all findings into two categories:
- **High-priority issues**: All P0 (Critical) and P1 (High Priority) findings
- **Low-priority issues**: Everything else (suggestions, nice-to-haves)

---

## Step 3: Check for High-Priority Issues

Evaluate the collected findings:

- **If NO high-priority issues (P0/P1) exist**: Go to Step 7 (post final review and finish)
- **If high-priority issues exist**: Proceed to Step 4

### Loop Guard

Track the current iteration count. **Maximum 5 iterations** to prevent infinite loops.

If the maximum is reached and high-priority issues still remain:
- Post a review comment listing the remaining unfixed issues
- Report to the user that manual intervention is needed
- Exit

---

## Step 4: Fix High-Priority Issues

For each high-priority issue found, apply the fix directly to the source code.

### Fix Strategy

Address issues in priority order: P0 first, then P1.

#### Fixable Issues (Apply Automatically)

| Category | Example | Fix Approach |
|----------|---------|--------------|
| Missing test coverage | New feature without tests | Write integration tests following project conventions |
| Mock convention violations | `vi.mock("../../internal")` | Refactor to mock at boundary only (use MSW, real DB, etc.) |
| Type safety issues | Use of `any`, missing types | Add proper types |
| Error handling anti-patterns | Defensive try/catch | Remove unnecessary try/catch, let errors propagate |
| Unused code | Dead imports, unused variables | Remove them |
| Testing anti-patterns | Fake timers, unit tests for internals | Rewrite tests to follow conventions |

#### Unfixable Issues (Report and Skip)

Some issues require architectural decisions or clarification:
- Ambiguous requirements
- Design trade-offs that need discussion
- Issues outside the scope of the PR

Mark these as **skipped** and include them in the final report.

### Important Rules

- **Only modify files that are part of the PR diff** — do not touch unrelated files
- **Follow project conventions** — refer to `docs/testing.md` for test patterns
- **Minimal changes** — fix the issue, nothing more
- **No new lint violations** — all fixes must pass linting

---

## Step 5: Run Pre-Commit Checks

After applying fixes, verify nothing is broken:

```bash
cd turbo && pnpm format
cd turbo && pnpm turbo run lint
cd turbo && pnpm check-types
cd turbo && pnpm vitest
```

If any check fails:
1. Attempt to fix the failure (e.g., format issues are auto-fixable)
2. If the failure is caused by the fix itself, revert the problematic fix and mark the issue as **skipped**
3. Re-run checks until they pass

---

## Step 6: Commit and Push

Stage and commit all fixes:

```bash
git add <fixed-files>
git commit -m "fix: address PR review findings (P0/P1 issues)"
git push
```

Report what was fixed in this iteration:
```
Iteration <N>: Fixed <count> issues
- <issue 1 summary>
- <issue 2 summary>
```

**Return to Step 2** to re-review with fresh analysis.

---

## Step 7: Post Final Review Comment

When no high-priority issues remain, run the full `/pr-review` to post the final review comment:

```typescript
await Skill({
  skill: "pr-review",
  args: `${PR_NUMBER}`
});
```

This posts the standard review comment to the PR.

---

## Final Report

Display a summary to the user:

```
PR Review Loop Complete

PR: #<number> - <title>
Branch: <branch>

Iterations: <count>
Total issues fixed: <count>
  P0 (Critical): <count> fixed, <count> skipped
  P1 (High Priority): <count> fixed, <count> skipped

[If skipped issues exist]
Remaining issues (manual intervention needed):
- <issue description>

Final review posted to PR.
Comment URL: <comment-url>
```

---

## Error Handling

### No PR Found
```
Error: No PR found for current branch.
Please create a PR first or specify a PR number.
```

### Max Iterations Reached
```
Review Loop Limit Reached (5 iterations)

The following high-priority issues could not be resolved automatically:
- <issue 1>
- <issue 2>

Please fix manually and re-run /pr-review-loop
```

### Pre-Commit Check Failure
If a fix introduces new failures that cannot be resolved:
- Revert the problematic fix
- Mark the original issue as skipped
- Continue with remaining fixes

---

## Best Practices

1. **Fix in priority order** — P0 before P1
2. **Minimal, targeted fixes** — Only change what's needed to resolve the issue
3. **Verify after each iteration** — Always re-review to catch regressions
4. **Respect the loop limit** — Don't fight issues that need human judgment
5. **Preserve PR intent** — Fixes should align with the original PR purpose
6. **No scope creep** — Only fix issues identified in the review, don't refactor unrelated code

Your goal is to automate the review-fix-review cycle until the PR is clean of high-priority issues, minimizing manual intervention while maintaining code quality.
