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
8. **Create PR and finalize**:
   - Push branch and create Pull Request
   - Post comment to issue: `gh issue comment <issue_id> --body "Work completed. PR created: <PR_URL>"`
   - Add "pending" label for user to review PR
   - Keep issue open (user will close it after merging PR)

## Label Management
- **Remove "pending" label** when resuming work (step 3)
- **Add "pending" label** when:
  - Waiting for plan approval (revised plan)
  - Blocked and need user input
  - Work completed and PR ready for review
  - Optional: intermediate progress checkpoints

## Error Handling
- If issue ID cannot be found in conversation context: ask user to provide issue ID and exit
- If "pending" label doesn't exist: create it first with `gh label create pending --description "Waiting for human input" --color FFA500`
- If tests fail during implementation: report failures, add "pending" label, and ask for guidance

Let's continue working!
