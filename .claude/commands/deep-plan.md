---
description: Create concrete implementation plan based on research and innovation findings
---

# DEEP PLAN MODE

You are entering **Deep Plan Mode**. This is the planning phase that transforms research findings and innovation discussions into a concrete implementation plan.

## PREREQUISITES

Before starting:
1. **Read research document** at `/tmp/deep-dive/{task-name}/research.md`
2. **Read innovation document** at `/tmp/deep-dive/{task-name}/innovate.md`

If either document is missing, inform the user and suggest running the appropriate phase first (`/deep-research` or `/deep-innovate`).

## CRITICAL RESTRICTIONS

**PERMITTED:**
- Creating detailed implementation steps
- Specifying file changes and modifications
- Defining task dependencies and order
- Breaking down work into actionable items
- Identifying potential blockers or risks
- Ensuring goal focus - connecting all planning to original requirements
- Documenting the plan in `/tmp/deep-dive/{task-name}/plan.md`

**ABSOLUTELY FORBIDDEN:**
- Actually writing or modifying code
- Making commits or file changes
- Running tests or build commands
- Any implementation execution
- Deviating from the chosen approach without user approval
- Skipping or abbreviating specifications

## CORE THINKING PRINCIPLES

Apply these thinking approaches during planning:

- **Systems Thinking**: Ensure the plan considers the full impact on the system
- **Sequential Thinking**: Order tasks logically based on dependencies
- **Risk Thinking**: Identify potential issues and mitigation strategies
- **Practical Thinking**: Keep the plan actionable and realistic

## PLANNING WORKFLOW

### Phase 1: Context Review

1. **Read research findings** from `/tmp/deep-dive/{task-name}/research.md`
2. **Read innovation document** from `/tmp/deep-dive/{task-name}/innovate.md`
3. **Confirm the chosen approach** with the user if not already decided

### Phase 2: Plan Development

1. **Break down into tasks:**
   - Identify all discrete work items
   - Order tasks by dependency
   - Group related tasks logically

2. **For each task, specify:**
   - Clear description of what needs to be done
   - Files that will be affected
   - Dependencies on other tasks
   - Acceptance criteria

3. **Define test requirements:**
   - **Unit tests**: Test individual functions, components, or modules in isolation
   - **E2E tests**: Test user-facing workflows and critical paths through the system
   - Specify which type of test is needed for each task
   - Include test file locations and key test scenarios

4. **Identify risks and blockers:**
   - Technical challenges
   - External dependencies
   - Areas requiring further investigation

### Phase 3: Documentation

1. **Create plan file** at `/tmp/deep-dive/{task-name}/plan.md`
2. **Structure the document:**
   - Chosen approach summary
   - Task breakdown with details
   - Test strategy (unit tests and e2e tests)
   - Dependency graph (if complex)
   - Risk assessment
   - Definition of done

### Phase 4: User Approval

1. **Present the plan** to the user
2. **Walk through** each major section
3. **Address questions** and concerns
4. **Get explicit approval** before proceeding to implementation
5. **Ask the user**: "Does this plan look good? Ready to proceed with implementation?"

## TASK TO PLAN

$ARGUMENTS

---

**Remember**: You are creating a roadmap for implementation. You are NOT implementing yet. The plan should be detailed enough that implementation can proceed smoothly, but no code should be written until the user approves and explicitly requests implementation.
