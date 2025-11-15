---
description: Complete end-to-end feature development from requirements to PR merge
---

You will execute the complete feature development workflow using the feature-developer agent.

## Usage

```bash
/develop <feature-description>
```

## What This Command Does

This command launches the **feature-developer** agent which handles the complete software development lifecycle:

1. **📋 Requirements Analysis**: Analyzes your feature request and creates implementation plan
2. **💻 Implementation**: Writes clean, tested code following project standards
3. **🔍 Local CI Checks**: Runs lint, format, type check, tests, and build locally
4. **📝 Git & PR**: Creates conventional commits and pull requests
5. **⏳ Pipeline Monitoring**: Waits for GitHub Actions checks to pass
6. **🔍 Code Quality Review**: Performs bad-smell analysis and fixes issues
7. **🎯 PR Merge**: Safely merges to main after all validations

## Examples

```bash
# Add a new feature
/develop add dark mode toggle to user settings

# Fix a bug
/develop fix database connection timeout in production

# Refactor code
/develop refactor authentication logic to use JWT tokens

# Add tests
/develop add e2e tests for project creation flow
```

## What to Expect

The agent will:
- ✅ Plan implementation tasks
- ✅ Implement feature with proper tests
- ✅ Run all quality checks locally
- ✅ Create PR with conventional commit
- ✅ Monitor GitHub pipeline until completion
- ✅ Check code against bad-smell.md standards
- ✅ Fix any issues found and re-check
- ✅ Merge PR when everything passes

## Requirements

Before using this command, ensure:
- You have a clear feature description
- GitHub CLI is authenticated (`gh auth login`)
- You're on a git branch (agent will create new one if on main)
- Dependencies are installed (`pnpm install`)

## Project Standards

The agent follows strict quality standards:
- **Zero `any` types** - All code must be type-safe
- **Zero lint suppressions** - Fix issues, don't hide them
- **Fail-fast error handling** - No unnecessary try/catch
- **YAGNI principle** - Start simple, avoid over-engineering
- **Real implementations** - Minimal mocking in tests
- **Conventional commits** - Strict format enforcement

## When It Will Stop and Ask

The agent will pause and ask for clarification if:
- Feature requirements are unclear
- Breaking changes are needed
- Multiple implementation approaches are possible
- Architecture changes required

## Estimated Time

Typical workflow duration:
- Simple features: 5-10 minutes
- Medium features: 15-30 minutes
- Complex features: 30+ minutes

Time includes:
- Implementation
- Local CI checks (~2-5 minutes)
- GitHub pipeline (~5-10 minutes)
- Code quality review
- PR merge

## Output

You'll receive detailed progress updates:
```
🚀 Feature Development Workflow
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Phase 1: Requirements Analysis ✅
💻 Phase 2: Implementation ✅
🔍 Phase 3: Local CI Checks ✅
📝 Phase 4: Git Commit & PR ✅
⏳ Phase 5: Pipeline Monitoring ✅
🔍 Phase 6: Bad Smell Analysis ✅
🎯 Phase 7: PR Merge ✅

🎉 Feature Development Complete!
```

## Troubleshooting

**If local CI checks fail:**
- Agent will auto-fix format/lint issues
- Manual fixes required for type errors/test failures
- Never bypass checks with --no-verify

**If pipeline fails:**
- Agent will review logs and fix issues
- May require additional commits
- Process restarts from local CI checks

**If bad smells detected:**
- Agent will fix all issues
- Re-runs CI checks and pipeline
- Continues until code is clean

## Related Commands

- `/pr-list` - List open pull requests
- `/pr-review <number>` - Review specific PR
- `/dev-start` - Start development server

## Advanced Usage

For more control over specific phases, use individual commands:
- Create PR manually: Use pr-creator agent
- Merge PR manually: Use pr-merger agent
- Just check code quality: Read spec/bad-smell.md

---

**Ready to start?** Just provide your feature description and the agent will handle the rest!
