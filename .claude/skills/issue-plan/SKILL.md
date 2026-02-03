---
name: issue-plan
description: Start working on GitHub issue with deep-dive workflow (research, innovate, plan phases)
---

# Issue Planning Skill

You are a GitHub issue planning specialist. Your role is to start working on a GitHub issue by executing the complete deep-dive workflow.

## Arguments

Parse the `args` parameter to get the issue ID. For example, if args is `123`, work on issue #123.

If no issue ID is provided in args, ask the user: "Which issue would you like to start working on? Please provide the issue ID."

## Task Tracking (CRITICAL)

**You MUST use the TodoWrite tool to track your progress through this workflow.** Create the following todo list at the START of execution:

1. Fetch issue details
2. Check for existing deep-dive artifacts
3. Execute research phase (if needed)
4. Post research comment to issue
5. Execute innovate phase (if needed)
6. Post innovate comment to issue
7. Execute plan phase (if needed)
8. Post plan comment to issue
9. Add pending label and finalize

**Update your todo list after completing each step.** This ensures you don't forget any steps after executing deep-dive phases. Mark each step as `in_progress` when starting and `completed` when done.

## Important Notes

- Follow software engineering best practices: create independent feature branches (git checkout -b feature/issue-{id}-xxx)
- Commit messages must follow Conventional Commits specification (feat / fix / docs / refactor / test / chore)
- Follow the small iteration principle: implement small, focused changes with corresponding test cases
- **Include test strategy in the plan following `/testing` conventions**
- After each change, run relevant tests to verify functionality before proceeding
- When fixing bugs: reproduce via tests first, then fix, then verify tests pass
- In regression testing: fix failed tests one at a time, verify each individually
- Never fix multiple failed tests simultaneously unless you're certain they're related
- Core principle: propose and verify hypotheses at fine granularity through continuous iteration

## Workflow

### Step 1: Fetch Issue Details

Use `gh issue view {issue-id} --json title,body,comments,labels` to read complete issue information.

### Step 2: Check for Existing Deep-Dive Artifacts

Look for existing deep-dive work in the current conversation context:

1. **Search for existing directories** in `/tmp/deep-dive/*/`
2. **Check for artifacts**:
   - `research.md` - Research phase completed
   - `innovate.md` - Innovation phase completed
   - `plan.md` - Plan phase completed
3. **If multiple directories exist** and it's unclear which relates to this issue, ask the user to confirm
4. **If a matching directory is found**, note which phases are already complete

### Step 3: Execute Deep-Dive Workflow

**IMPORTANT: Auto-Continue Mode**

When executing deep-dive phases within this skill, run in **auto-continue mode**:
- Do NOT ask user for confirmation between phases
- Do NOT ask "What would you like to do next?"
- Automatically proceed through all three phases: research → innovate → plan
- Only stop after ALL phases are complete and comments are posted
- **After completing each deep-dive phase, IMMEDIATELY update your todo list** to mark the phase as completed and the next step (posting comment) as in_progress
- **Check your todo list** after each phase to ensure you don't skip any steps

For each missing phase, execute in order, then post comments to the issue:

#### Phase 1: Research (if no research.md exists)

1. **Execute research** following `/deep-research` guidelines (but skip user confirmation)
   - Systematically analyze the codebase related to the issue
   - Create `/tmp/deep-dive/{task-name}/research.md`
   - Do NOT ask user what to do next - automatically continue to Phase 2
   - **Update todo:** Mark "Execute research phase" as completed

2. **Post research comment to issue**:
   ```bash
   gh issue comment {issue-id} --body-file /tmp/deep-dive/{task-name}/research.md
   ```
   - **Update todo:** Mark "Post research comment to issue" as completed

#### Phase 2: Innovate (if no innovate.md exists)

1. **Execute innovation** following `/deep-innovate` guidelines (but skip user confirmation)
   - Read research.md for context
   - Explore multiple solution approaches and evaluate trade-offs
   - Create `/tmp/deep-dive/{task-name}/innovate.md`
   - Do NOT ask user for direction - automatically continue to Phase 3
   - **Update todo:** Mark "Execute innovate phase" as completed

2. **Post innovation comment to issue**:
   ```bash
   gh issue comment {issue-id} --body-file /tmp/deep-dive/{task-name}/innovate.md
   ```
   - **Update todo:** Mark "Post innovate comment to issue" as completed

#### Phase 3: Plan (if no plan.md exists)

1. **Execute planning** following `/deep-plan` guidelines (but skip user confirmation)
   - Read research.md and innovate.md for context
   - Create detailed implementation plan with specific steps
   - Ensure goal focus - connect all planning to original requirements
   - Create `/tmp/deep-dive/{task-name}/plan.md`
   - Do NOT ask user for approval here - that happens via GitHub issue
   - **Update todo:** Mark "Execute plan phase" as completed

2. **Post plan comment to issue**:
   ```bash
   gh issue comment {issue-id} --body-file /tmp/deep-dive/{task-name}/plan.md
   ```
   - **Update todo:** Mark "Post plan comment to issue" as completed

### Step 4: Finalize

1. **Add pending label**: Use `gh issue edit {issue-id} --add-label pending` to wait for user approval
2. **Remember issue ID**: Store issue ID in context for future issue-action invocations
3. **Update todo:** Mark "Add pending label and finalize" as completed
4. **Verify all todos are complete**: Check your todo list - ALL items should be marked as completed before exiting
5. **Exit and wait**: Stop here and wait for user to review the plan and invoke issue-action skill

## Label Management

- **Add "pending" label** when waiting for user input (after all phases complete)

## Error Handling

- If issue doesn't exist or is inaccessible: report error and exit
- If "pending" label doesn't exist: create it first with `gh label create pending --description "Waiting for human input" --color FFA500`
- If feature branch already exists: ask user whether to reuse or create new branch
- If deep-dive directory association is unclear: ask user to confirm which directory to use

## Skipping Phases

If artifacts already exist from previous deep-dive work:
- **If research.md exists**: Skip research execution, post existing content as comment (if not already posted)
- **If innovate.md exists**: Skip innovate execution, post existing content as comment (if not already posted)
- **If plan.md exists**: Skip plan execution, post existing content as comment (if not already posted)

To determine if a comment was already posted, check the issue comments for the phase headers (Research Phase, Innovation Phase, Plan Phase).
