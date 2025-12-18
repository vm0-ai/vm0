# Start Working on GitHub Issue

Your job is to start working on GitHub issue {{ISSUE_ID}} for the current project. This command integrates with the deep-dive workflow to ensure thorough exploration before implementation.

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

### Step 1: Fetch Issue Details

Use `gh issue view {{ISSUE_ID}} --json title,body,comments,labels` to read complete issue information.

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

When executing deep-dive phases within `/issue-todo`, run in **auto-continue mode**:
- Do NOT ask user for confirmation between phases
- Do NOT ask "What would you like to do next?"
- Automatically proceed through all three phases: research → innovate → plan
- Only stop after ALL phases are complete and comments are posted

For each missing phase, execute in order, then post comments to the issue:

#### Phase 1: Research (if no research.md exists)

1. **Execute research** following `/deep-research` guidelines (but skip user confirmation)
   - Systematically analyze the codebase related to the issue
   - Create `/tmp/deep-dive/{task-name}/research.md`
   - Do NOT ask user what to do next - automatically continue to Phase 2

2. **Post research comment to issue**:
   ```
   gh issue comment {{ISSUE_ID}} --body "$(cat <<'EOF'
   ## 🔬 Research Phase

   [Contents of research.md]

   ---
   *Phase 1/3 of deep-dive workflow*
   EOF
   )"
   ```

#### Phase 2: Innovate (if no innovate.md exists)

1. **Execute innovation** following `/deep-innovate` guidelines (but skip user confirmation)
   - Read research.md for context
   - Explore multiple solution approaches and evaluate trade-offs
   - Create `/tmp/deep-dive/{task-name}/innovate.md`
   - Do NOT ask user for direction - automatically continue to Phase 3

2. **Post innovation comment to issue**:
   ```
   gh issue comment {{ISSUE_ID}} --body "$(cat <<'EOF'
   ## 💡 Innovation Phase

   [Contents of innovate.md]

   ---
   *Phase 2/3 of deep-dive workflow*
   EOF
   )"
   ```

#### Phase 3: Plan (if no plan.md exists)

1. **Execute planning** following `/deep-plan` guidelines (but skip user confirmation)
   - Read research.md and innovate.md for context
   - Create detailed implementation plan with specific steps
   - Ensure goal focus - connect all planning to original requirements
   - Create `/tmp/deep-dive/{task-name}/plan.md`
   - Do NOT ask user for approval here - that happens via GitHub issue

2. **Post plan comment to issue**:
   ```
   gh issue comment {{ISSUE_ID}} --body "$(cat <<'EOF'
   ## 📋 Plan Phase

   [Contents of plan.md]

   ---
   *Phase 3/3 - Ready for approval*
   EOF
   )"
   ```

### Step 4: Finalize

1. **Add pending label**: Use `gh issue edit {{ISSUE_ID}} --add-label pending` to wait for user approval
2. **Remember issue ID**: Store {{ISSUE_ID}} in context for future `/issue-continue` calls
3. **Exit and wait**: Stop here and wait for user to review the plan and call `/issue-continue`

## Label Management
- **Add "pending" label** when waiting for user input (after all phases complete)

## Error Handling
- If issue doesn't exist or is inaccessible: report error and exit
- If "pending" label doesn't exist: create it first with `gh label create pending --description "Waiting for human input" --color FFA500`
- If feature branch already exists: ask user whether to reuse or create new branch
- If deep-dive directory association is unclear: ask user to confirm which directory to use

## Skipping Phases

If artifacts already exist from previous deep-dive work:
- **If research.md exists**: Skip `/deep-research`, post existing content as comment (if not already posted)
- **If innovate.md exists**: Skip `/deep-innovate`, post existing content as comment (if not already posted)
- **If plan.md exists**: Skip `/deep-plan`, post existing content as comment (if not already posted)

To determine if a comment was already posted, check the issue comments for the phase headers (🔬 Research Phase, 💡 Innovation Phase, 📋 Plan Phase).

Let's get started!
