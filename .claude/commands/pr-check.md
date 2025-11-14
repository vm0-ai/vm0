---
description: Automated PR pipeline monitoring, issue fixing, and merging workflow
---

# PR Check Command

Automated PR pipeline monitoring, issue fixing, and merging workflow.

## Usage

```
/pr-check [pr-id]
```

## Parameters

- `pr-id`: (Optional) GitHub PR number. If not provided, uses the current branch's PR

## Workflow

When this command is executed, perform the following steps in order:

### Step 1: Identify Target PR

1. If `pr-id` is provided, use that PR
2. Otherwise, get the current branch using `git branch --show-current`
3. Find the PR for current branch: `gh pr list --head {branch} --json number --jq '.[0].number'`
4. If no PR found, exit with error

### Step 2: Wait for Pipeline

Wait 60 seconds for the pipeline to complete or stabilize:
- This allows CI/CD to process recent commits
- Display countdown: "Waiting: XX seconds remaining"

### Step 3: Check Pipeline Status

Check the pipeline status using: `gh pr checks {pr-id}`

Possible outcomes:
- **All passing**: Continue to merge step
- **Failures detected**: Proceed to fix attempts
- **Still running**: Wait 30 seconds and retry (up to 3 times)

### Step 4: Fix Detected Issues

Based on failure types, attempt automatic fixes:

#### For Lint Failures (if output contains "lint" and "fail"):
1. Navigate to turbo directory: `cd /workspaces/vm0/turbo`
2. Run formatter: `pnpm format`
3. If changes detected:
   - Stage changes: `git add -A`
   - Commit: `git commit -m "fix: auto-format code"`
   - Push: `git push`
4. Wait 60 seconds for pipeline to restart

#### For Test Failures (if output contains "test" and "fail"):
1. Navigate to turbo directory: `cd /workspaces/vm0/turbo`
2. Run tests locally: `pnpm test`
3. Report whether tests pass locally or need manual fix
4. Note: If tests pass locally but fail in CI, it may be an environment issue

#### For Type Check Failures (if output contains "type" or "check-types" and "fail"):
1. Navigate to turbo directory: `cd /workspaces/vm0/turbo`
2. Run type checks: `pnpm check-types`
3. Report results (manual fix usually required)

After any successful fix:
- Reset retry counter
- Wait for pipeline to process the fix
- Re-check pipeline status

### Step 5: Final Verification

After fixes (or if no fixes needed):
1. Run final pipeline check: `gh pr checks {pr-id}`
2. If still failing after 3 retry attempts, exit with error
3. If passing, proceed to merge

### Step 6: Merge the PR

If all checks pass, execute merge workflow:

1. Merge using squash strategy: `gh pr merge {pr-id} --squash --delete-branch`
2. After successful merge:
   - Switch to main: `git checkout main`
   - Pull latest: `git pull origin main`
   - Confirm on latest main

## Configuration

- **Initial wait**: 60 seconds before first check
- **Retry attempts**: Maximum 3 times
- **Retry delay**: 30 seconds between attempts
- **Fix wait**: 60 seconds after pushing fixes

## Error Conditions

Exit with error if:
- No PR exists for current branch
- Pipeline checks fail after all retry attempts
- Unable to find turbo directory for fixes
- Merge operation fails

## Success Criteria

Command succeeds when:
- All pipeline checks pass (with or without fixes)
- PR is successfully merged
- Branch switched back to main

## Example Output

```
🔍 Starting automated PR check workflow...
✓ Found PR #123 for current branch

⏱️ Step 1: Waiting 60 seconds for pipeline to complete...
✓ Wait completed

🔄 Checking pipeline status...
❌ Pipeline has failures:
lint    fail    ...

🔧 Attempting to fix lint issues...
Running pnpm format...
✓ Code formatted successfully
✓ Fixes pushed to remote

⏳ Waiting for pipeline to restart after fixes...
🔄 Checking pipeline status...
✓ All pipeline checks passed!

🎉 Step 3: All checks passed! Proceeding to merge...
🔀 Squash merging PR...
✅ PR #123 successfully merged!

🔄 Switching to main branch...
✓ Now on latest main branch

🎉 PR check workflow completed successfully!
```

## Notes

- This command combines monitoring, fixing, and merging into one workflow
- Designed for the project's specific CI/CD setup
- Automatically handles common issues that can be fixed programmatically
- Uses squash merge to keep main branch history clean
- Preserves commit messages in squashed commit
