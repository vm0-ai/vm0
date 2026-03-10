---
name: pr-review-loop
description: Iteratively review PR, fix high-priority issues, and re-review until clean
context: fork
---

You are a PR review-and-fix specialist for the vm0 project. Your role is to iteratively review a pull request, fix all high-priority issues found, and re-review until no high-priority issues remain.

## Architecture

Loop control is handled by a **bash driver script**, not by your memory. You MUST follow the ACTION output from the driver script at every step. The driver script is deterministic — it enforces the review-fix-review cycle and prevents skipping re-review after fixes.

```
┌──────────┐     ACTION: REVIEW      ┌─────────┐
│  Driver   │ ──────────────────────→ │   LLM   │
│  Script   │ ←────────────────────── │ (you)   │
│           │   review-done {p0} {p1} │         │
│           │                         │         │
│           │     ACTION: FIX         │         │
│           │ ──────────────────────→ │         │
│           │ ←────────────────────── │         │
│           │       fix-done          │         │
│           │                         │         │
│           │     ACTION: FINALIZE    │         │
│           │ ──────────────────────→ │         │
└──────────┘                          └─────────┘
```

---

## Phase 1: Setup

### 1a: Identify PR

**CRITICAL — do this FIRST before anything else.**

Your args are: `$ARGUMENTS`

Extract the PR number from the args above using these rules:
1. **Args is a URL** containing `/pull/<number>` or `/issues/<number>` → extract `<number>` (e.g., `https://github.com/vm0-ai/vm0/pull/4128` → `4128`)
2. **Args is a plain number** → use it directly (e.g., `4128`)
3. **Args is empty** → detect from current branch using `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`

Once you have the PR number, **hardcode it as a literal** in all subsequent bash commands. Never use shell variables for the PR number derived from args — always substitute the actual number directly.

### 1b: Checkout PR Branch

Switch to the PR branch so that fixes are applied to the correct code:

```bash
gh pr checkout <PR_NUMBER>
```

### 1c: Create Driver Script

Write this script to `/tmp/pr-review-loop-driver.sh` and make it executable:

```bash
cat > /tmp/pr-review-loop-driver.sh << 'DRIVER'
#!/bin/bash
set -euo pipefail

PR="$1"
CMD="$2"
STATE="/tmp/pr-review-loop-${PR}.state"

case "$CMD" in
  init)
    echo "0" > "$STATE"
    echo "ACTION: REVIEW"
    ;;
  review-done)
    P0="${3:-0}"
    P1="${4:-0}"
    ITER=$(cat "$STATE")
    ITER=$((ITER + 1))
    echo "$ITER" > "$STATE"
    if [ "$P0" -eq 0 ] && [ "$P1" -eq 0 ]; then
      echo "ACTION: FINALIZE"
    elif [ "$ITER" -ge 5 ]; then
      echo "ACTION: FINALIZE_WITH_REMAINING"
    else
      echo "ACTION: FIX"
    fi
    ;;
  fix-done)
    echo "ACTION: REVIEW"
    ;;
esac
DRIVER
chmod +x /tmp/pr-review-loop-driver.sh
```

### 1d: Initialize

```bash
ACTION=$(/tmp/pr-review-loop-driver.sh "$PR_NUMBER" init)
# Output: ACTION: REVIEW
```

Display PR metadata, then proceed to Phase 2 following the ACTION.

---

## Phase 2: Action Loop

Read the ACTION output from the driver script and execute the corresponding action. **Always call the driver script after completing an action to get the next ACTION.**

### On `ACTION: REVIEW`

1. Run the `code-quality` skill (analysis only, do NOT post a comment):

```typescript
await Skill({
  skill: "code-quality",
  args: `review ${PR_NUMBER}`
});
```

2. Perform testing coverage and convention review (same checks as `/pr-review`):
   - Identify changed source files from PR diff
   - Check test coverage for new features and bug fixes
   - Check testing conventions against project standards

3. Read review results:

```bash
REVIEW_DIR="codereviews/$(date +%Y%m%d)"
cat "$REVIEW_DIR/commit-list.md"
```

4. Count P0 and P1 issues from the findings.

5. **Report the counts to the driver script:**

```bash
ACTION=$(/tmp/pr-review-loop-driver.sh "$PR_NUMBER" review-done "$P0_COUNT" "$P1_COUNT")
```

6. Follow the returned ACTION.

---

### On `ACTION: FIX`

1. Fix all P0 issues first, then P1 issues:

| Category | Fix Approach |
|----------|--------------|
| Missing test coverage | Write integration tests following project conventions |
| Mock convention violations | Refactor to mock at boundary only (MSW, real DB) |
| Type safety issues | Add proper types |
| Error handling anti-patterns | Remove unnecessary try/catch |
| Unused code | Remove dead imports/variables |
| Testing anti-patterns | Rewrite tests to follow conventions |

   Mark unfixable issues (ambiguous requirements, design trade-offs, out of scope) as **skipped**.

   Rules:
   - Only modify files that are part of the PR diff
   - Minimal changes — fix the issue, nothing more

2. Run pre-commit checks:

```bash
cd turbo && pnpm format
cd turbo && pnpm turbo run lint
cd turbo && pnpm check-types
cd turbo && pnpm vitest
```

   If a fix breaks checks: revert that fix, mark the issue as skipped.

3. Commit and push:

```bash
git add <fixed-files>
git commit -m "fix: address PR review findings"
git push
```

4. **Report completion to the driver script:**

```bash
ACTION=$(/tmp/pr-review-loop-driver.sh "$PR_NUMBER" fix-done)
# Output is ALWAYS: ACTION: REVIEW
```

5. Follow the returned ACTION (which is always REVIEW — this is how the loop is enforced).

---

### On `ACTION: FINALIZE` or `ACTION: FINALIZE_WITH_REMAINING`

Go to Phase 3.

---

## Phase 3: Finalize

1. Run `/pr-review` to post the final review comment:

```typescript
await Skill({
  skill: "pr-review",
  args: `${PR_NUMBER}`
});
```

2. Display summary:

```
PR Review Loop Complete

PR: #{number} - {title}
Iterations: {count}
Issues fixed: {count}

[If FINALIZE_WITH_REMAINING]
Max iterations reached. Remaining issues need manual intervention:
- {issue}

Final review posted.
Comment URL: {url}
```
