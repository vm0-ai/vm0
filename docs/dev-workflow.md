# Development Workflow

This document describes the standard workflow for developing features and fixing bugs using Claude Code's integrated issue management system.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Issue Creation                               │
├─────────────────────────────────────────────────────────────────────┤
│  Complex Work              │  Simple Work                           │
│  /deep-research ───────────┼──────────────────┐                     │
│         │                  │                  │                     │
│         v                  │                  v                     │
│  /deep-innovate ───────────┴──────────> /issue-create               │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                        /issue-plan                                   │
│              (Auto-generate work plan)                               │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                       Human Review                                   │
│          (Review issue link and work plan)                           │
├─────────────────────────────────────────────────────────────────────┤
│     Approved?                                                        │
│     ├── Yes ──> /issue-action                                        │
│     └── No ───> Add comments, revise plan                            │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                      /issue-action                                   │
│         (Implementation → PR → CI passes)                            │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                        /pr-review                                    │
│            (Automated code review + Human review)                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                         Merge PR                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Step-by-Step Guide

### 1. Issue Creation

#### For Complex Work

When dealing with complex features, architectural changes, or unclear requirements:

1. Start with `/deep-research` to explore the problem space
2. Run `/deep-innovate` to explore 2-3 approaches with trade-offs
3. Once the scope is clear, run `/issue-create` with well-defined acceptance criteria

#### For Simple Work

When the task is straightforward (bug fixes, small features, clear requirements):

1. Describe the work to Claude
2. Run `/issue-create` directly based on the description

### 2. Generate Work Plan

Run `/issue-plan` to:
- Analyze the issue requirements
- Break down the work into actionable tasks
- Create a structured implementation plan
- Update the issue with the work plan

### 3. Human Review of Work Plan

After `/issue-plan` completes:

1. Claude provides the **issue link**
2. Review the generated work plan in the issue
3. Check if the plan:
   - Covers all requirements
   - Has reasonable task breakdown
   - Follows project conventions

#### If the plan looks good:
Proceed to step 4.

#### If changes are needed:
- Add comments to the issue with your feedback
- Ask Claude to revise the plan based on your comments
- Repeat until the plan is satisfactory

### 4. Implementation

Run `/issue-action` to:
- Implement the work plan
- Create commits following conventional commit format
- Create a pull request
- Ensure CI passes

This command handles the entire implementation cycle automatically.

### 5. Code Review

Run `/pr-review` to:
- Perform automated code review
- Post review comments on the PR
- Identify potential issues or improvements

**Important:** Human review is also required at this stage:
- Review the code changes
- Check for edge cases
- Verify the implementation matches requirements
- Add comments if changes are needed

### 6. Merge

Once both automated and human reviews are complete:
- Approve the PR
- Merge to the main branch

## Quick Reference

| Step | Command | Description |
|------|---------|-------------|
| Research | `/deep-research` | Explore complex problems before creating issues |
| Innovate | `/deep-innovate` | Explore 2-3 approaches with trade-offs |
| Create | `/issue-create` | Create GitHub issue from conversation |
| Work Plan | `/issue-plan` | Generate work plan for an issue |
| Implement | `/issue-action` | Continue working on issue until PR is ready |
| Review | `/pr-review` | Automated code review with PR comments |
| CI Fix | `/pr-check` | Monitor CI pipeline, auto-fix failures |

## Best Practices

1. **Always review the work plan** - The generated plan sets the direction for implementation
2. **Provide clear feedback** - If the plan needs changes, be specific in your comments
3. **Don't skip human review** - Automated review catches common issues, but human judgment is essential
4. **Keep issues focused** - One issue should represent one logical unit of work
