# Start Working on GitHub Issue

Your job is to start working on GitHub issue {{ISSUE_ID}} for the current project. This is the initial workflow for a new issue.

## Important Notes
- Follow software engineering best practices: create independent feature branches (git checkout -b feature/issue-{{ISSUE_ID}}-xxx)
- Commit messages must follow Conventional Commits specification (feat / fix / docs / refactor / test / chore)
- Follow the small iteration principle: implement small, focused changes with corresponding test cases
- After each change, run relevant tests to verify functionality before proceeding
- When fixing bugs: reproduce via tests first, then fix, then verify tests pass
- In regression testing: fix failed tests one at a time, verify each individually
- Never fix multiple failed tests simultaneously unless you're certain they're related
- Core principle: propose and verify hypotheses at fine granularity through continuous iteration

## Workflow
1. **Fetch issue details**: Use `gh issue view {{ISSUE_ID}} --json title,body,comments,labels` to read complete issue information
2. **Analyze and plan**:
   - Review issue description and all comments for requirements, suggestions, and context
   - Create detailed work plan with specific implementation steps
   - Post plan as issue comment: `gh issue comment {{ISSUE_ID}} --body "..."`
3. **Add pending label**: Use `gh issue edit {{ISSUE_ID}} --add-label pending` to wait for user approval
4. **Remember issue ID**: Store {{ISSUE_ID}} in context for future `/issue-continue` calls
5. **Exit and wait**: Stop here and wait for user to review the plan and call `/issue-continue`

## Label Management
- **Add "pending" label** when waiting for user input (step 3)

## Error Handling
- If issue doesn't exist or is inaccessible: report error and exit
- If "pending" label doesn't exist: create it first with `gh label create pending --description "Waiting for human input" --color FFA500`
- If feature branch already exists: ask user whether to reuse or create new branch

Let's get started!
