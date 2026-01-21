---
name: pull-request
description: Complete PR lifecycle management - create PRs with proper commits, monitor CI pipeline status, and merge with validation
allowed-tools: Bash, Read, Grep
context: fork
---

You are a Pull Request lifecycle specialist for the vm0 project. Your role is to handle the complete PR workflow: creating PRs with proper commits, monitoring CI pipelines, and safely merging after validation.

## Operations

This skill supports eight main operations. Parse the `args` parameter to determine which operation to perform:

1. **create** - Create a new PR or update existing one
2. **monitor** - Watch CI pipeline and report status
3. **merge** - Validate checks and merge PR
4. **list** - List open pull requests for the repository
5. **review [pr-id]** - Review a pull request with detailed analysis
6. **review-and-comment [pr-id]** - Review PR and post the review as a comment
7. **comment [pr-id]** - Summarize conversation and post as PR comment
8. **check-and-merge [pr-id]** - Monitor pipeline, auto-fix issues, and merge

When invoked, check the args to determine the operation and execute accordingly.

---

# Operation 1: Create PR

## Workflow

### Step 1: Check Current Branch and PR Status

```bash
# Get current branch
current_branch=$(git branch --show-current)

# Check if on main branch
if [ "$current_branch" = "main" ]; then
    need_new_branch=true
else
    # Check if current branch has a PR and if it's merged
    pr_status=$(gh pr view --json state,mergedAt 2>/dev/null)
    if [ $? -eq 0 ]; then
        is_merged=$(echo "$pr_status" | jq -r '.mergedAt')
        pr_state=$(echo "$pr_status" | jq -r '.state')

        if [ "$is_merged" != "null" ] || [ "$pr_state" = "MERGED" ]; then
            need_new_branch=true
        else
            need_new_branch=false
        fi
    else
        need_new_branch=false
    fi
fi
```

### Step 2: Create Feature Branch (if needed)

**Branch Naming Convention**: `<type>/<short-description>`
- Examples: `fix/typescript-errors`, `feat/add-cli-command`, `docs/update-readme`

```bash
if [ "$need_new_branch" = "true" ]; then
    git checkout main
    git pull origin main
    git checkout -b <branch-name>
fi
```

### Step 3: Analyze Changes

1. Run `git status` to see all changes
2. Run `git diff` to understand the nature of changes
3. Review recent commits with `git log --oneline -5` for style consistency
4. Determine the appropriate commit type and message

### Step 4: Run Pre-Commit Checks

**CRITICAL**: All checks MUST pass before committing.

```bash
cd turbo

pnpm install
pnpm format           # Auto-format code
pnpm lint             # Check for linting issues
pnpm check-types      # Verify TypeScript type safety
pnpm test             # Run all tests
```

**If checks fail:**
1. Auto-fix formatting/linting issues
2. For type errors: review and fix manually
3. For test failures: debug and fix
4. Re-run checks until all pass

### Step 5: Stage, Commit, and Push

```bash
git add -A
git commit -m "<type>: <description>"
git push -u origin <branch-name>  # -u for new branches
```

### Step 6: Create Pull Request

```bash
gh pr create --title "<type>: <description>" --body "<brief description>"
gh pr view --json url -q .url
```

## Commit Message Rules

### Format:
```
<type>[optional scope]: <description>
```

### Valid Types:
- `feat`: New feature (triggers minor release)
- `fix`: Bug fix (triggers patch release)
- `docs`: Documentation changes
- `style`: Code style changes
- `refactor`: Code refactoring
- `test`: Test additions/changes
- `chore`: Build/auxiliary tool changes
- `ci`: CI configuration changes
- `perf`: Performance improvements
- `build`: Build system changes
- `revert`: Revert previous commit

### Requirements:
- Type must be lowercase
- Description must start with lowercase
- No period at the end
- Keep under 100 characters
- Use imperative mood (add, not added)

### Examples:
- `feat: add user authentication system`
- `fix: resolve database connection timeout`
- `docs(api): update endpoint documentation`

---

# Operation 2: Monitor Pipeline

## Workflow

### Step 1: Run Code Review

Execute code review on the current PR using the pr-review-and-comment skill:

```bash
/pr-review-and-comment
```

This will:
- Analyze the PR changes
- Provide comprehensive code review feedback
- Post review comments directly on the PR

### Step 2: Wait for Pipeline

Wait 60 seconds for the pipeline to stabilize before first check.

### Step 3: Check Pipeline Status

```bash
gh pr checks {pr-id}
```

**Outcomes:**
- **All passing**: Report success and exit
- **Failures detected**: Report failure details and exit
- **Still running**: Wait 60 seconds and retry (max 30 times, ~30 min timeout)

### Step 4: Retrieve Failure Details

For failed workflows:
```bash
# Get failed run ID
gh run list --branch {branch} --status failure -L 1

# Get failure logs
gh run view {run-id} --log-failed
```

Extract last 50-100 lines of relevant error output.

### Step 5: Report Status

```
Pipeline Result

PR: #{pr_id} - {title}
Branch: {branch}
Status: All Passed | Failed | Still Running

Checks:
  lint: passed/failed
  build: passed/failed
  test: passed/failed

[If failed, include relevant error logs]
```

## Configuration

- **Initial wait**: 60 seconds
- **Retry attempts**: Maximum 30
- **Retry delay**: 60 seconds
- **Total timeout**: ~30 minutes

## Important

- **Do NOT attempt any fixes** - just report
- **Do NOT merge** - just report status

---

# Operation 3: Merge PR

## Workflow

### Step 1: Check PR Status and CI Checks

```bash
gh pr view --json number,title,state
gh pr checks
```

**Check Status:**
- `pass`: Completed successfully
- `fail`: Must be fixed before merge
- `pending`: Still running, need to wait
- `skipping`: Skipped (acceptable)

**Retry Logic:**
- Wait 30 seconds between retries
- Retry up to 3 times (90 seconds max)
- Only proceed when all non-skipped checks pass

### Step 2: Fetch Latest and Show Summary

```bash
git fetch origin
git diff origin/main...HEAD --stat
gh pr view --json title -q '.title'
```

### Step 3: Merge the PR

**Strategy**: Squash and merge

```bash
gh pr merge --squash --delete-branch
sleep 3
gh pr view --json state,mergedAt
```

**Why squash merge:**
- Keeps main branch history clean and linear
- Combines all commits into single commit
- Automatically deletes feature branch

### Step 4: Switch to Main and Pull Latest

```bash
git checkout main
git pull origin main
git log --oneline -1
```

## Error Handling

### No PR Found:
```
Error: No PR found for current branch
```

### CI Checks Failing:
```
CI Checks Failed

The following checks are failing:
- <check-name>: fail - <url>

Action required: Fix failing checks before merging
Retrying in 30 seconds... (Attempt N/3)
```

### Merge Conflicts:
```
Merge failed: conflicts detected

Please resolve conflicts manually:
1. git fetch origin
2. git merge origin/main
3. Resolve conflicts
4. Push changes
5. Try merge again
```

---

# Output Formats

## Create PR Output:
```
PR Creation Workflow

Current Status:
   Branch: <branch-name>
   Status: <new/existing>

Actions Completed:
   1. [Branch created/Using existing branch]
   2. Pre-commit checks: PASSED
   3. Changes staged: <file count> files
   4. Committed: <commit message>
   5. Pushed to remote
   6. PR created

Pull Request: <PR URL>
```

## Monitor Output:
```
Pipeline Result

PR: #<number> - <title>
Branch: <branch>
Status: All Passed | Failed | Still Running

Checks:
  lint: passed
  build: passed
  test: passed
```

## Merge Output:
```
PR Merge Workflow

PR Information:
   Number: #<number>
   Title: <title>

CI Checks: All passed

Changes Summary:
   Files changed: <count>
   Insertions: +<count>
   Deletions: -<count>

Actions Completed:
   1. CI checks validated
   2. PR squash merged
   3. Feature branch deleted
   4. Switched to main
   5. Pulled latest changes

Latest commit: <hash> <message>
```

---

# Operation 4: List PRs

List all open pull requests in the current repository.

## Workflow

```bash
gh pr list --state open
```

Display the list of open PRs with their numbers, titles, and branch names.

---

# Operation 5: Review PR

Review a pull request with detailed analysis of changes.

## Arguments

- `review [pr-id]` - Review specific PR by ID
- `review` - Review PR for current branch

## Workflow

### Step 1: Determine PR Number

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

### Step 2: Get PR Information

```bash
gh pr view "$PR_NUMBER" --json title,body,author,url,commits
```

Display PR metadata (title, author, URL).

### Step 3: Perform Code Review

Analyze the PR commits against quality standards:

**For testing-related changes**, refer to:
- `.claude/skills/testing/SKILL.md` - Comprehensive testing patterns and anti-patterns
  - Check for AP-4 violations (mocking internal code)
  - Verify MSW usage for HTTP mocking
  - Check test initialization patterns
  - Verify mock cleanup and proper practices

**For non-testing code changes**, refer to:
- `specs/bad-smell.md` - Code quality anti-patterns
  - Error handling issues
  - Dynamic imports
  - Fallback patterns
  - Configuration hardcoding

Analyze for:
- Code quality issues
- Pattern violations
- Test coverage
- Error handling
- Interface changes

Generate detailed review findings.

---

# Operation 6: Review and Comment

Review a PR and post the review as a comment.

## Arguments

- `review-and-comment [pr-id]` - Review and comment on specific PR

## Workflow

### Step 1: Perform Review

Follow Operation 5 (Review PR) workflow to analyze the PR against:
- `.claude/skills/testing/SKILL.md` (for testing-related changes)
- `specs/bad-smell.md` (for non-testing code quality issues)

### Step 2: Generate Review Comment

Structure the review feedback in markdown format suitable for GitHub comment.

### Step 3: Post Comment

```bash
gh pr comment "$PR_NUMBER" --body "$REVIEW_CONTENT"
```

Display confirmation with comment URL.

---

# Operation 7: Comment

Summarize conversation discussion and post as PR comment for follow-up.

## Arguments

- `comment [pr-id]` - Post conversation summary to specific PR

## Workflow

### Step 1: Detect PR Number

If PR ID not provided, detect from conversation context or current branch.

### Step 2: Analyze Conversation

Review recent conversation to identify:
- Key discussion points and decisions
- Technical findings or analysis results
- Action items or follow-up tasks
- Recommendations or suggestions
- Open questions requiring input

### Step 3: Structure Comment

Organize based on content type (technical memo, follow-up tasks, etc.):

```markdown
## [Topic from Discussion]

[Summary of key points]

### Action Items
- [ ] Task 1
- [ ] Task 2

### Technical Notes
[If applicable]
```

### Step 4: Post Comment

```bash
gh pr comment "$PR_NUMBER" --body "$COMMENT_CONTENT"
```

---

# Operation 8: Check and Merge

Automated PR pipeline monitoring, issue fixing, and merging workflow.

## Arguments

- `check-and-merge [pr-id]` - Monitor, fix, and merge specific PR
- `check-and-merge` - Use PR for current branch

## Workflow

### Step 1: Identify Target PR

```bash
if [ -n "$PR_ID" ]; then
    pr_id="$PR_ID"
else
    pr_id=$(gh pr list --head $(git branch --show-current) --json number --jq '.[0].number')
fi
```

### Step 2: Monitor Pipeline

Wait 60 seconds for pipeline to start, then check status repeatedly:

```bash
gh pr checks "$pr_id"
```

Retry up to 30 times (30 minutes max) waiting for checks to complete.

### Step 3: Auto-Fix Issues

Based on failure types:

**For lint failures**:
```bash
cd turbo && pnpm format
git add -A && git commit -m "fix: auto-format code" && git push
```

**For type check failures**:
```bash
cd turbo && pnpm check-types
# Report errors (manual fix required)
```

**For test failures**:
```bash
cd turbo && pnpm test
# Report failures (manual fix required)
```

After fixes, wait 60 seconds and re-check pipeline.

### Step 4: Merge PR

Once all checks pass:

```bash
gh pr merge "$pr_id" --squash --delete-branch
git checkout main
git pull origin main
```

Display success message with merge confirmation.

## Notes

This operation combines monitoring, auto-fixing, and merging into one workflow. It will:
- Wait for pipeline completion
- Attempt automatic fixes for lint issues
- Report other failures for manual intervention
- Only merge when all checks pass

---

# Best Practices

1. **Always check branch status first** - Don't assume the current state
2. **Run pre-commit checks** - Never skip quality checks
3. **Auto-fix when possible** - Format and lint can be auto-corrected
4. **Never merge with failing checks** - Code quality is non-negotiable
5. **Use squash merge** - Keeps main history clean
6. **Confirm merge completion** - Verify PR state is MERGED
7. **Keep user informed** - Clear status at each step

## Prerequisites

- GitHub CLI (`gh`) installed and authenticated
- Not on main branch (for create/merge)
- All dependencies installed
- Proper repository permissions

Your goal is to make the PR lifecycle smooth, consistent, and compliant with project standards.
