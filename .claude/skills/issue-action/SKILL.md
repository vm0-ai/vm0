---
name: issue-action
description: Continue working on GitHub issue from conversation context
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task
context: fork
---

# Issue Action Skill

You are a GitHub issue implementation specialist. Your role is to continue working on a GitHub issue from the current conversation context, following the approved plan from the issue-plan skill.

## Important Notes

- This skill does NOT require issue ID as args - it automatically uses the issue from current conversation
- Follow software engineering best practices: work on existing feature branch or create new one if needed
- Commit messages must follow Conventional Commits specification (feat / fix / docs / refactor / test / chore)
- Follow the small iteration principle: implement small, focused changes with corresponding test cases
- After each change, run relevant tests to verify functionality before proceeding
- When fixing bugs: reproduce via tests first, then fix, then verify tests pass
- In regression testing: fix failed tests one at a time, verify each individually
- Never fix multiple failed tests simultaneously unless you're certain they're related
- Core principle: propose and verify hypotheses at fine granularity through continuous iteration

## Workflow

### Step 1: Retrieve Context

1. **Find issue ID** from conversation history (from previous issue-plan or issue-action invocations)
   - If no issue ID found: Ask user "Which issue would you like to continue working on? Please provide the issue ID."
   - Exit and wait for user response if issue ID not found

2. **Locate deep-dive artifacts** in `/tmp/deep-dive/{task-name}/`
   - Find the directory associated with this issue from conversation context
   - If multiple directories exist and association is unclear, ask user to confirm
   - Verify these files exist:
     - `research.md` - Codebase analysis and technical constraints
     - `innovate.md` - Chosen approach and reasoning
     - `plan.md` - Implementation steps to follow

### Step 2: Fetch Latest Updates

Use `gh issue view {issue-id} --json title,body,comments,labels` to get all comments since last interaction.

### Step 3: Remove Pending Label

Use `gh issue edit {issue-id} --remove-label pending` to indicate work has resumed.

### Step 4: Analyze Feedback

Review new comments for:
- Plan approval/rejection
- Modification requests
- Additional requirements
- Questions or clarifications

### Step 5: Take Action Based on Feedback

- **If plan approved**: Proceed to implementation (Step 6)
- **If changes requested**:
  - Update `/tmp/deep-dive/{task-name}/plan.md`
  - Post revised plan as comment
  - Add "pending" label and exit
- **If questions asked**:
  - Answer questions in comment
  - Add "pending" label and exit

### Step 6: Implementation

1. **Read deep-dive artifacts**:
   - Read `plan.md` for the exact implementation steps to follow
   - Reference `research.md` for codebase understanding and navigation
   - Reference `innovate.md` for the chosen approach and its rationale

2. **Create/switch to feature branch**

3. **Implement changes following plan.md exactly**:
   - Follow the implementation steps in order
   - Do not deviate from the approved plan without user approval
   - If plan is unclear or needs adjustment, post comment and add "pending" label

4. **Write and run tests after each change**

5. **Commit with conventional commit messages**

### Step 7: Check Completion Status

- **If work complete**: Create PR and go to Step 8
- **If blocked or need clarification**: Post comment explaining the situation, add "pending" label, and exit
- **If intermediate checkpoint**: Post progress update comment, add "pending" label, and exit (optional)

### Step 8: Create PR and Verify CI Pipeline

1. Push branch and create Pull Request

2. Wait 60 seconds for CI workflows to start

3. Check and fix pipeline issues:
   - Use `gh pr checks` to check pipeline status
   - **If checks still running**: Wait 30 seconds and retry (up to 10 times total)
   - **If checks failing**: Attempt automatic fixes:
     - **Lint failures** (if output contains "lint" and "fail"):
       1. Run `cd turbo && pnpm format`
       2. If changes detected: `git add -A && git commit -m "fix: auto-format code" && git push`
       3. Wait 60 seconds and re-check pipeline
     - **Type check failures** (if output contains "type" or "check-types" and "fail"):
       1. Run `cd turbo && pnpm check-types`
       2. Report errors (manual fix required)
     - **Test failures** (if output contains "test" and "fail"):
       1. Run `cd turbo && pnpm vitest`
       2. Report failures (manual fix required)
     - After pushing fixes, wait 60 seconds and re-check pipeline
     - Retry fix attempts up to 2 times
   - **If checks pass** (after fixes or initially): Post success comment to issue
   - **If unable to fix after retries**: Post comment with failure details and add "pending" label, then exit

4. Post comment to issue:
   ```bash
   gh issue comment {issue-id} --body "Work completed. PR created: {pr-url}

   All CI checks passing"
   ```

5. Keep issue open (user will close it after merging PR)

## Label Management

- **Remove "pending" label** when resuming work (Step 3)
- **Add "pending" label** when:
  - Waiting for plan approval (revised plan)
  - Blocked and need user input
  - Optional: intermediate progress checkpoints

## Error Handling

- If issue ID cannot be found in conversation context: ask user to provide issue ID and exit
- If deep-dive artifacts not found: ask user if they want to run issue-plan skill first
- If "pending" label doesn't exist: create it first with `gh label create pending --description "Waiting for human input" --color FFA500`
- If tests fail during implementation: report failures, add "pending" label, and ask for guidance
