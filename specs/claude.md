# Claude Code Migration Plan

This document outlines the migration of Claude Code configuration from the uspark project to vm0, focusing on generic, reusable components that enhance development workflows.

## Overview

The uspark project has a mature `.claude` directory structure with specialized agents, commands, and skills that automate common development tasks. This migration plan identifies components that are business-agnostic and can be adapted for vm0.

## Migration Goals

1. **Automate PR Workflow**: Streamline pull request creation, review, and merging
2. **Enforce Code Quality**: Implement automated pre-commit checks and validation
3. **Standardize Commits**: Adopt Conventional Commits specification with validation
4. **Monitor CI/CD**: Automate GitHub Actions monitoring and failure detection
5. **Document Standards**: Establish clear code quality guidelines

## Components to Migrate

### 1. Agents (Specialized Task Handlers)

#### ✅ commit-validator
**Purpose**: Validates and helps create proper Conventional Commits messages

**Why Migrate**:
- 100% generic, no business logic
- Enforces consistent commit history
- Enables automated versioning with tools like release-please
- Provides clear validation rules and fix suggestions

**Source**: `/tmp/uspark/.claude/agents/commit-validator.md`

#### ✅ pre-commit-checker
**Purpose**: Comprehensive pre-commit quality checks (format, lint, type check, tests)

**Why Migrate**:
- Universal code quality enforcement
- Prevents committing broken code
- Auto-fixes formatting and linting issues
- Reduces CI/CD pipeline failures

**Source**: `/tmp/uspark/.claude/agents/pre-commit-checker.md`

**Adjustments Needed**:
- Update working directory paths (from `/turbo` to vm0 structure)
- Adjust CI check commands to match vm0's package.json scripts
- Configure package manager (pnpm/npm/yarn)

#### ✅ pr-creator
**Purpose**: Automates branch management, pre-commit checks, commit creation, and PR creation

**Why Migrate**:
- Eliminates manual PR workflow steps
- Ensures quality checks before commits
- Handles branch creation logic intelligently
- Generates proper PR titles and descriptions

**Source**: `/tmp/uspark/.claude/agents/pr-creator.md`

**Adjustments Needed**:
- Update pre-commit check commands
- Confirm package manager usage
- Adapt to vm0's CI/CD setup

#### ✅ pr-merger
**Purpose**: Automates PR merge workflow with CI validation and branch cleanup

**Why Migrate**:
- Validates all CI checks before merging
- Handles merge queue/squash merge strategies
- Automatic branch cleanup and sync
- Retry logic for pending checks

**Source**: `/tmp/uspark/.claude/agents/pr-merger.md`

**Adjustments Needed**:
- Configure merge strategy (auto-merge vs squash)
- Adjust retry timing based on vm0's CI duration

#### ✅ pr-pipeline-monitor
**Purpose**: Monitors GitHub Actions status and retrieves failure logs

**Why Migrate**:
- Quick identification of CI failures
- Automated log retrieval for debugging
- Clear status reporting
- No business-specific logic

**Source**: `/tmp/uspark/.claude/agents/pr-pipeline-monitor.md`

### 2. Commands (Slash Commands)

#### ✅ pr-check.md
**Purpose**: Complete automated PR workflow - review, monitor, fix, merge

**Why Migrate**:
- Combines multiple steps into one command
- Automatic issue detection and fixing
- Intelligent retry logic
- Reduces manual PR management overhead

**Source**: `/tmp/uspark/.claude/commands/pr-check.md`

**Adjustments Needed**:
- Remove `/code-review` command invocation (uspark-specific)
- Adjust wait times and retry counts if needed
- Configure turbo directory path

#### ✅ Retain Existing Commands
Keep current vm0 commands:
- `pr-list.md` - List open PRs
- `pr-review.md` - Review specific PR with analysis

#### ⚠️ Consider Deprecating
- `pr-create.md` - Superseded by pr-creator agent
- `pr-merge.md` - Superseded by pr-merger agent

### 3. Skills (Reusable Documentation Modules)

#### ✅ conventional-commits/
**Purpose**: Complete guide to Conventional Commits specification

**Why Migrate**:
- Industry-standard commit format
- Enables automated versioning and changelogs
- Clear examples and validation rules
- Release trigger documentation

**Source**: `/tmp/uspark/.claude/skills/conventional-commits/`
- `SKILL.md` - Overview and quick reference
- `types.md` - Detailed commit type definitions
- `examples.md` - Good and bad examples
- `release-triggers.md` - What triggers releases

#### ✅ project-principles/ (Optional but Recommended)
**Purpose**: Core architectural and code quality principles

**Why Migrate**:
- Establishes clear coding standards
- Documents design philosophy
- Guides architectural decisions
- Prevents technical debt accumulation

**Source**: `/tmp/uspark/.claude/skills/project-principles/`
- `SKILL.md` - Overview of four core principles
- `yagni.md` - You Aren't Gonna Need It principle
- `no-defensive.md` - Avoid defensive programming
- `type-safety.md` - Strict type checking guidelines
- `zero-lint.md` - Zero tolerance for lint violations

**Adjustments Needed**:
- Review and adapt to match vm0's existing CLAUDE.md guidelines
- Ensure consistency between skill docs and project docs
- Remove or adapt any uspark-specific references

### 4. Specifications

#### ✅ bad-smell.md
**Purpose**: Comprehensive code quality anti-patterns and bad practices guide

**Why Migrate**:
- Universal code quality guidelines
- Specific, actionable rules
- Covers common pitfalls across testing, typing, and architecture
- Language/framework agnostic principles

**Source**: `/tmp/uspark/spec/bad-smell.md`

**Key Categories**:
1. Mock Analysis - Minimize mocking, prefer real implementations
2. Test Coverage - Quality over quantity
3. Error Handling - Fail fast, avoid defensive programming
4. Interface Changes - Document breaking changes
5. Timer/Delay Analysis - No fake timers or artificial delays
6. Dynamic Imports - Prohibit dynamic imports
7. Database Mocking - Use real DB in tests
8. Test Mock Cleanup - Always clear mocks between tests
9. TypeScript `any` - Zero tolerance
10. Artificial Delays - No setTimeout in tests
11. Hardcoded URLs - Use centralized config
12. Direct DB Operations - Use API endpoints in tests
13. Fail Fast - No fallback patterns
14. Lint Suppressions - Zero tolerance
15. Bad Tests - Avoid fake, brittle, or meaningless tests

**Adjustments Needed**:
- Replace uspark-specific examples (e.g., `globalThis.services`)
- Adapt database/API patterns to vm0's architecture
- Remove framework-specific references if not applicable (e.g., Next.js)

### 5. Configuration

#### ✅ settings.json
**Purpose**: Placeholder for future Claude Code settings

**Why Migrate**:
- Establishes structure for configuration
- Currently empty but enables future customization

**Source**: `/tmp/uspark/.claude/settings.json`

## Components NOT to Migrate

### ❌ feature-developer agent
**Reason**: Contains uspark-specific paths (`/workspaces/uspark1/`), workflow references, and bad-smell.md integration

### ❌ e2e-ui-tester agent
**Reason**: Tightly coupled to uspark's Clerk authentication, specific URLs, and testing infrastructure

### ❌ develop command
**Reason**: Invokes uspark-specific feature-developer agent

### ❌ code-review command
**Reason**: References uspark-specific bad-smell.md document locations and workflow

### ❌ dev-start/stop/logs/auth commands
**Reason**: Contain uspark-specific paths, certificate generation, and domain configurations

## Proposed Directory Structure

```
vm0/
├── .claude/
│   ├── agents/
│   │   ├── commit-validator.md       [NEW]
│   │   ├── pre-commit-checker.md     [NEW]
│   │   ├── pr-creator.md             [NEW]
│   │   ├── pr-merger.md              [NEW]
│   │   └── pr-pipeline-monitor.md    [NEW]
│   ├── commands/
│   │   ├── pr-check.md               [NEW]
│   │   ├── pr-list.md                [KEEP]
│   │   ├── pr-review.md              [KEEP]
│   │   ├── pr-create.md              [DEPRECATE - use pr-creator agent]
│   │   └── pr-merge.md               [DEPRECATE - use pr-merger agent]
│   ├── skills/
│   │   ├── conventional-commits/     [NEW]
│   │   │   ├── SKILL.md
│   │   │   ├── types.md
│   │   │   ├── examples.md
│   │   │   └── release-triggers.md
│   │   └── project-principles/       [NEW - OPTIONAL]
│   │       ├── SKILL.md
│   │       ├── yagni.md
│   │       ├── no-defensive.md
│   │       ├── type-safety.md
│   │       └── zero-lint.md
│   └── settings.json                 [NEW]
├── specs/
│   ├── bad-smell.md                  [NEW]
│   ├── claude.md                     [THIS FILE]
│   └── github-action.md              [EXISTING]
└── CLAUDE.md                         [EXISTING]
```

## Migration Steps

### Phase 1: Foundation (Specifications)
1. Copy `bad-smell.md` to `specs/`
2. Create this migration plan as `specs/claude.md`
3. Review and adapt bad-smell.md to vm0's architecture

### Phase 2: Skills (Documentation)
1. Create `skills/conventional-commits/` directory
2. Copy all 4 files from uspark
3. Review for uspark-specific references
4. Optionally add `skills/project-principles/`

### Phase 3: Agents (Core Automation)
1. Create `agents/` directory
2. Copy and adapt each agent:
   - commit-validator.md (no changes needed)
   - pre-commit-checker.md (update paths and commands)
   - pr-creator.md (update paths and commands)
   - pr-merger.md (configure merge strategy)
   - pr-pipeline-monitor.md (no changes needed)

### Phase 4: Commands (User Interface)
1. Add `pr-check.md` to commands/
2. Remove `/code-review` invocation from pr-check
3. Update turbo/directory paths in pr-check
4. Add deprecation notes to pr-create.md and pr-merge.md

### Phase 5: Configuration
1. Create empty `settings.json`
2. Document settings structure for future use

### Phase 6: Testing & Validation
1. Test `/pr-check` command end-to-end
2. Verify pr-creator agent workflow
3. Validate commit-validator with test commits
4. Confirm pre-commit-checker with sample changes
5. Test pr-merger agent with test PR

### Phase 7: Documentation Updates
1. Update CLAUDE.md to reference new agents
2. Add usage examples for new commands
3. Document new workflow patterns
4. Create quick-start guide

## Required Adjustments by Component

### pre-commit-checker.md
```markdown
# Line 34: Change working directory
- OLD: cd /workspaces/uspark1/turbo
+ NEW: cd /workspaces/vm0  # Or appropriate vm0 path

# Lines 79-83: Update check commands
- OLD: pnpm turbo run lint
- OLD: pnpm check-types
- OLD: pnpm vitest
+ NEW: [Match vm0's package.json scripts]
```

### pr-creator.md
```markdown
# Lines 72-83: Update pre-commit check commands
- OLD: cd turbo && pnpm install
- OLD: pnpm turbo run lint
+ NEW: [Match vm0's structure and commands]

# Line 76: Package manager
- Confirm: pnpm vs npm vs yarn
```

### pr-merger.md
```markdown
# Line 62: Merge strategy
- Review: Does vm0 use merge queue?
- Configure: --auto vs --squash vs --merge

# Lines 39-40: Retry timing
- Adjust retry delays based on vm0's CI duration
```

### pr-check.md
```markdown
# Lines 28-30: Remove code-review command
- DELETE: Step 2 (Run Code Review)
- UPDATE: Renumber subsequent steps

# Lines 54-55: Update turbo path
- OLD: cd turbo
+ NEW: [vm0's appropriate path]
```

### bad-smell.md
```markdown
# Line 79: Update service mocking reference
- OLD: globalThis.services
+ NEW: [vm0's service pattern]

# Line 115: Update hardcoded URL examples
- OLD: "https://uspark.dev"
+ NEW: [vm0's domain examples]

# Line 124: Update database operations
- Adapt to vm0's DB access pattern
```

### project-principles/* (if migrated)
```markdown
# All files: Cross-reference with CLAUDE.md
- Ensure consistency with existing vm0 guidelines
- Remove uspark-specific examples
- Add vm0-specific examples where helpful
```

## Benefits After Migration

### 1. Automated Workflows
- Single command (`/pr-check`) for complete PR lifecycle
- Automated quality checks before every commit
- Reduced manual intervention in CI/CD process

### 2. Code Quality
- Consistent commit message format
- Enforced pre-commit standards
- Clear code quality guidelines
- Prevention of common anti-patterns

### 3. Developer Experience
- Faster PR workflow
- Clear validation feedback
- Automated error detection and fixing
- Reduced context switching

### 4. Team Collaboration
- Standardized processes across team
- Self-documenting workflow (via agents)
- Clear quality expectations
- Easier onboarding for new developers

### 5. CI/CD Efficiency
- Fewer pipeline failures (pre-commit checks)
- Automated failure diagnosis (pipeline monitor)
- Intelligent retry logic
- Reduced CI/CD costs

## Testing Plan

### Commit Validation
```bash
# Test conventional commit validation
# Make a test change
echo "test" >> test.txt
git add test.txt

# Try invalid commit (should be caught)
git commit -m "Invalid commit message"

# Agent should suggest: feat: add test file
```

### Pre-commit Checks
```bash
# Trigger pre-commit-checker agent
# Should run: format, lint, type check, tests
# Should auto-fix formatting/linting
# Should report type errors clearly
```

### PR Creation
```bash
# Use pr-creator agent
# Should: create branch, run checks, commit, create PR
# Should: handle existing PRs vs new PRs
```

### PR Check Workflow
```bash
# Run /pr-check command
# Should: monitor pipeline, fix issues, merge
# Should: handle lint failures automatically
# Should: report test failures clearly
```

### Pipeline Monitoring
```bash
# Test with failing PR
# Should: identify failed checks
# Should: retrieve relevant logs
# Should: suggest fixes
```

## Rollback Plan

If migration causes issues:

1. **Keep original commands**: pr-create.md and pr-merge.md retained
2. **Agents are additive**: Can be disabled without affecting existing workflow
3. **Skills are documentation**: No runtime impact
4. **bad-smell.md is reference**: No enforcement without explicit use

## Success Metrics

After migration, measure:
- Reduction in PR creation time
- Decrease in CI/CD pipeline failures
- Improved commit message consistency
- Faster issue diagnosis and resolution
- Developer satisfaction with workflow

## Future Enhancements

After successful migration:
1. Add custom vm0-specific agents
2. Integrate bad-smell.md analysis into CI/CD
3. Create automated release workflow
4. Add development environment commands
5. Build custom pre-commit hooks using agents

## References

- Conventional Commits: https://www.conventionalcommits.org/
- Release Please: https://github.com/googleapis/release-please
- Claude Code Docs: https://docs.claude.com/claude-code

## Conclusion

This migration brings mature, battle-tested automation from uspark to vm0, focusing on universal development workflow improvements. All components are generic and adaptable, requiring only path and command adjustments to fit vm0's structure.

The migration is low-risk, high-reward, with clear rollback paths and measurable benefits. Start with Phase 1-3 for core functionality, then expand based on team needs and feedback.
