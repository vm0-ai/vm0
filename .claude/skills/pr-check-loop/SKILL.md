---
name: pr-check-loop
description: Monitor PR CI pipeline, auto-fix issues, and loop until all checks pass
context: fork
---

You are a CI pipeline monitor for the vm0 project. Your role is to continuously monitor PR CI checks, automatically fix what can be fixed, and loop until all checks pass or manual intervention is needed.

## Architecture

Loop control is handled by a **bash driver script**, not by your memory. You MUST follow the ACTION output from the driver script at every step. The driver script is deterministic — it enforces the check-fix cycle.

```
┌──────────┐     ACTION: REVIEW_PR     ┌─────────┐
│  Driver   │ ──────────────────────→   │   LLM   │  ← check if PR has been reviewed
│  Script   │ ←──────────────────────   │ (you)   │
│           │   review-done             │         │
│           │                           │         │
│           │     ACTION: WAIT          │         │  ← sleep 60s for CI to settle
│           │ ──────────────────────→   │         │
│           │ ←──────────────────────   │         │
│           │       wait-done           │         │
│           │                           │         │
│           │     ACTION: CHECK         │         │  ← poll CI status
│           │ ──────────────────────→   │         │
│           │ ←──────────────────────   │         │
│           │   check-done <status>     │         │
│           │                           │         │
│           │     ACTION: FIX           │         │  ← auto-fix lint/format
│           │ ──────────────────────→   │         │
│           │ ←──────────────────────   │         │
│           │       fix-done            │         │
│           │                           │         │
│           │     ACTION: PASS          │         │  ← all checks passed, done
│           │ ──────────────────────→   │         │
│           │                           │         │
│           │     ACTION: MANUAL        │         │  ← type/test errors, exit
│           │ ──────────────────────→   │         │
│           │                           │         │
│           │     ACTION: TIMEOUT       │         │  ← max iterations, exit
│           │ ──────────────────────→   │         │
└──────────┘                            └─────────┘
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

### 1b: Create Driver Script

Write this script to `/tmp/pr-check-loop-driver.sh` and make it executable:

```bash
cat > /tmp/pr-check-loop-driver.sh << 'DRIVER'
#!/bin/bash
set -euo pipefail

PR="$1"
CMD="$2"
STATE="/tmp/pr-check-loop-${PR}.state"
FIXES="/tmp/pr-check-loop-${PR}.fixes"

case "$CMD" in
  init)
    echo "0" > "$STATE"
    echo "0" > "$FIXES"
    echo "ACTION: REVIEW_PR"
    ;;
  review-done)
    echo "ACTION: WAIT"
    ;;
  wait-done)
    echo "ACTION: CHECK"
    ;;
  check-done)
    STATUS="${3:-pending}"
    ITER=$(cat "$STATE")
    ITER=$((ITER + 1))
    echo "$ITER" > "$STATE"
    case "$STATUS" in
      pass)
        echo "ACTION: PASS"
        ;;
      fail-fixable)
        if [ "$ITER" -ge 30 ]; then
          echo "ACTION: TIMEOUT"
        else
          echo "ACTION: FIX"
        fi
        ;;
      fail-manual)
        echo "ACTION: MANUAL"
        ;;
      pending)
        if [ "$ITER" -ge 30 ]; then
          echo "ACTION: TIMEOUT"
        else
          echo "ACTION: WAIT"
        fi
        ;;
    esac
    ;;
  fix-done)
    FIXES_COUNT=$(cat "$FIXES")
    FIXES_COUNT=$((FIXES_COUNT + 1))
    echo "$FIXES_COUNT" > "$FIXES"
    echo "ACTION: WAIT"
    ;;
esac
DRIVER
chmod +x /tmp/pr-check-loop-driver.sh
```

### 1c: Initialize

```bash
ACTION=$(/tmp/pr-check-loop-driver.sh "$PR_NUMBER" init)
# Output: ACTION: REVIEW_PR
```

Display PR metadata, then proceed to Phase 2 following the ACTION.

---

## Phase 2: Action Loop

Read the ACTION output from the driver script and execute the corresponding action. **Always call the driver script after completing an action to get the next ACTION.**

### On `ACTION: REVIEW_PR`

Check if the PR already has a code review comment:

```bash
comments=$(gh pr view "$pr_id" --json comments --jq '.comments[].body')
```

Look for review comments containing patterns like:
- "## Code Review"
- "LGTM"
- "Changes Requested"

**If no review found**: Execute `/pr-review` to analyze the PR and post findings.

**If review exists**: Skip to next action.

Report to driver:

```bash
ACTION=$(/tmp/pr-check-loop-driver.sh "$PR_NUMBER" review-done)
# Output: ACTION: WAIT
```

Follow the returned ACTION.

---

### On `ACTION: WAIT`

Wait 60 seconds for CI pipeline to settle:

```bash
sleep 60
```

Report to driver:

```bash
ACTION=$(/tmp/pr-check-loop-driver.sh "$PR_NUMBER" wait-done)
# Output: ACTION: CHECK
```

Follow the returned ACTION.

---

### On `ACTION: CHECK`

Poll CI status and merge status in parallel:

```bash
gh pr checks "$pr_id"
```

```bash
gh pr view "$pr_id" --json mergeable,mergeStateStatus --jq '{mergeable, mergeStateStatus}'
```

Classify the result:

1. **Merge conflict detected** (`mergeable: CONFLICTING` or `mergeStateStatus: DIRTY`) → status is `fail-manual`. This takes priority over CI status — there is no point fixing lint if the branch has conflicts.
2. **All checks `pass` or `skipping`** → status is `pass`
3. **Any check `fail`** → analyze failure type:
   - Lint/format failures only → status is `fail-fixable`
   - Type/test failures (with or without lint/format) → status is `fail-manual`
4. **No failures, some `pending`** → status is `pending`

**Fail-fast**: If ANY check has `fail` status, classify immediately without waiting for pending checks.

When failures are detected (not merge conflicts), get failure details:

```bash
# Get the PR branch
branch=$(gh pr view "$pr_id" --json headRefName --jq '.headRefName')

# Get failed run ID
gh run list --branch "$branch" --status failure -L 1

# Get failure logs
gh run view {run-id} --log-failed
```

When merge conflicts are detected, include rebase guidance in the manual report:

```
Merge conflict detected. The branch has conflicts with the base branch.
Rebase onto main to resolve:
  git fetch origin main
  git rebase origin/main
  # resolve conflicts
  git push --force-with-lease
```

Report to driver:

```bash
ACTION=$(/tmp/pr-check-loop-driver.sh "$PR_NUMBER" check-done "$STATUS")
```

Follow the returned ACTION.

---

### On `ACTION: FIX`

Auto-fix lint/format issues only:

```bash
cd turbo
pnpm format
pnpm lint --fix
```

If changes were made, commit and push:

```bash
git add -A
git commit -m "fix: auto-format code"
git push
```

Report to driver:

```bash
ACTION=$(/tmp/pr-check-loop-driver.sh "$PR_NUMBER" fix-done)
# Output: ACTION: WAIT
```

Follow the returned ACTION (loops back to WAIT → CHECK).

---

### On `ACTION: PASS`

All CI checks passed. Go to Phase 3.

---

### On `ACTION: MANUAL`

Type check or test failures detected that cannot be auto-fixed.

Display clear instructions:

```
Manual Intervention Required

The following issues cannot be auto-fixed:
- <issue type>: <details>

Please fix manually and re-run /pr-check-loop
```

Go to Phase 3.

---

### On `ACTION: TIMEOUT`

Maximum iterations (30) reached (~30 minutes).

```
Pipeline Timeout

CI checks did not complete/pass within 30 iterations.
Please check GitHub Actions for details:
<workflow-url>
```

Go to Phase 3.

---

## Phase 3: Summary

### Check if Fixes Were Made

```bash
FIXES=$(cat /tmp/pr-check-loop-${PR_NUMBER}.fixes)
ITER=$(cat /tmp/pr-check-loop-${PR_NUMBER}.state)
```

If fixes > 0, run `/pr-review` again to review the auto-fixed code.

### Final Report

Display a local summary (do NOT post another comment):

```
PR Check Loop Complete

PR: #<number> - <title>
Branch: <branch>
Iterations: <ITER>
Auto-fixes applied: <FIXES> commits
Status: <All Passed / Manual Fix Required / Timeout>

Checks:
  <check-name>: <status>
  ...

[If all passed]
All CI checks passed. Ready for manual review and merge.

[If all passed and fixes were made]
All CI checks passed after auto-fixing lint/format issues.
Final review posted.

[If manual fix required]
Manual intervention needed:
- <issue details>

[If timeout]
CI checks did not complete within the time limit.
Check GitHub Actions for details.
```

---

## Important Notes

1. **No Auto-Merge**: This skill does NOT merge the PR. Merging is a manual decision.
2. **Driver-Controlled Loop**: All loop logic is in the bash driver script. Follow its ACTIONs exactly.
3. **Auto-Fix Scope**: Only lint and format errors are auto-fixed. Type and test errors require manual intervention and exit the loop.
4. **Fail-Fast**: Does NOT wait for all checks to complete. Acts immediately on first failure detected.
5. **Review Triggers**:
   - Initial review: If no existing review comment found
   - Final review: If any fixes were committed during the process
6. **Idempotent**: Safe to re-run. Driver state resets on init.

---

## Best Practices

1. **Always check status first** - Don't assume pipeline state
2. **Auto-fix conservatively** - Only fix lint/format, not logic
3. **Clear reporting** - User should always know what happened
4. **Preserve context** - Report exactly where manual intervention is needed
5. **No silent failures** - Always communicate the outcome

Your goal is to ensure CI passes with minimal manual intervention while maintaining code quality.
