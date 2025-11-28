# Continue Working on GitHub Issue

Your job is to continue working on the GitHub issue from the current conversation context. This continues from where `/issue-todo` left off.

## Important Notes
- This command does NOT accept issue ID parameter - it automatically uses the issue from current conversation
- Follow software engineering best practices: work on existing feature branch or create new one if needed
- Commit messages must follow Conventional Commits specification (feat / fix / docs / refactor / test / chore)
- Follow the small iteration principle: implement small, focused changes with corresponding test cases
- After each change, run relevant tests to verify functionality before proceeding
- When fixing bugs: reproduce via tests first, then fix, then verify tests pass
- In regression testing: fix failed tests one at a time, verify each individually
- Never fix multiple failed tests simultaneously unless you're certain they're related
- Core principle: propose and verify hypotheses at fine granularity through continuous iteration

## Workflow
1. **Retrieve issue ID from context**:
   - Look through the current conversation history to find the issue ID from previous `/issue-todo` or `/issue-continue` calls
   - If no issue ID found in context: Ask user "Which issue would you like to continue working on? Please provide the issue ID."
   - Exit and wait for user response if issue ID not found
2. **Fetch latest updates**: Use `gh issue view <issue_id> --json title,body,comments,labels` to get all comments since last interaction
3. **Remove pending label**: Use `gh issue edit <issue_id> --remove-label pending` to indicate work has resumed
4. **Analyze feedback**: Review new comments for:
   - Plan approval/rejection
   - Modification requests
   - Additional requirements
   - Questions or clarifications
5. **Take action based on feedback**:
   - **If plan approved**: Proceed with implementation
   - **If changes requested**: Update plan and post revised plan as comment, then add "pending" label and exit
   - **If questions asked**: Answer questions in comment, then add "pending" label and exit
6. **Implementation**:
   - Create/switch to feature branch
   - Implement changes following the approved plan
   - Write and run tests after each change
   - Commit with conventional commit messages
7. **Check completion status**:
   - **If work complete**: Create PR and go to step 8
   - **If blocked or need clarification**: Post comment explaining the situation, add "pending" label, and exit
   - **If intermediate checkpoint**: Post progress update comment, add "pending" label, and exit (optional)
8. **Create PR and verify CI pipeline**:
   - Push branch and create Pull Request
   - Wait 60 seconds for CI workflows to start
   - Check and fix pipeline issues:
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
   - Post comment to issue: `gh issue comment <issue_id> --body "Work completed. PR created: <PR_URL>\n\n✅ All CI checks passing"`
   - Keep issue open (user will close it after merging PR)

## Label Management
- **Remove "pending" label** when resuming work (step 3)
- **Add "pending" label** when:
  - Waiting for plan approval (revised plan)
  - Blocked and need user input
  - Optional: intermediate progress checkpoints

## Error Handling
- If issue ID cannot be found in conversation context: ask user to provide issue ID and exit
- If "pending" label doesn't exist: create it first with `gh label create pending --description "Waiting for human input" --color FFA500`
- If tests fail during implementation: report failures, add "pending" label, and ask for guidance

Let's continue working!
