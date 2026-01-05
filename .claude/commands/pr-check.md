---
description: Automated PR pipeline monitoring and issue fixing (no auto-merge)
---

# PR Check Command

Automated PR pipeline monitoring and issue fixing workflow. This command does NOT merge the PR - it waits for user review after all checks pass.

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

### Step 2: Wait and Check Pipeline Status

Use the **pr-pipeline-monitor** agent to wait for pipeline and check status:

```typescript
await Task({
  description: "Monitor PR pipeline",
  prompt: `Monitor PR #${pr_id} pipeline status.`,
  subagent_type: "pr-pipeline-monitor"
});
```

### Step 3: Handle Result

Based on the agent's result:
- **All passing**: Continue to final report
- **Failures detected**: Proceed to fix attempts
- **Still running**: Agent will retry up to 30 times (~30 min), then report timeout

### Step 4: Fix Detected Issues

Based on failure types, attempt automatic fixes:

#### For Lint Failures (if output contains "lint" and "fail"):
1. Navigate to turbo directory: `cd /workspaces/vm0/turbo`
2. Run formatter: `pnpm format`
3. If changes detected:
   - Stage changes: `git add -A`
   - Commit: `git commit -m "fix: auto-format code"`
   - Push: `git push`
4. Go back to Step 2 (re-run agent)

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
- Go back to Step 2 (re-run agent)
- Re-check pipeline status

### Step 5: Final Verification

After fixes (or if no fixes needed):
1. If still failing after 3 retry attempts, exit with error
2. If passing, proceed to final report

### Step 6: Report and Await User Review

**IMPORTANT: Do NOT merge the PR automatically.**

If all checks pass:
1. Display PR URL: `gh pr view {pr-id} --json url --jq '.url'`
2. Show PR summary: title, description, changed files count
3. Report success message indicating the PR is ready for review
4. Remind user they can:
   - Review the PR manually
   - Use `/pr-check-and-merge` to auto-merge
   - Merge manually via `gh pr merge {pr-id} --squash --delete-branch`

## Configuration

- **Pipeline monitoring**: See pr-pipeline-monitor agent configuration
- **Fix wait**: 60 seconds after pushing fixes

## Error Conditions

Exit with error if:
- No PR exists for current branch
- Pipeline checks fail after all retry attempts
- Unable to find turbo directory for fixes

## Success Criteria

Command succeeds when:
- All pipeline checks pass (with or without fixes)
- PR status is reported to user
- User is informed about next steps

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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ PR #123 is ready for review!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 PR Summary:
   Title: feat: add new feature
   Files changed: 5
   URL: https://github.com/org/repo/pull/123

📝 Next steps:
   • Review the PR at the URL above
   • Use /pr-check-and-merge to auto-merge
   • Or merge manually: gh pr merge 123 --squash --delete-branch
```

## Notes

- This command monitors and fixes issues but does NOT merge
- Use `/pr-check-and-merge` if you want automatic merging
- Designed for workflows where human review is required before merge
- Automatically handles common issues that can be fixed programmatically
- Uses pr-pipeline-monitor agent to handle the waiting/polling
