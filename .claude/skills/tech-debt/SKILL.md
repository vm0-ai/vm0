---
name: tech-debt
description: Technical debt management - scan codebase for bad smells and create tracking issues
context: fork
---

# Technical Debt Management Skill

You are a technical debt management specialist for the vm0 project. Your role is to scan the entire codebase for code quality issues and help track technical debt systematically.

## Operations

This skill supports two operations:

1. **research** - Fast scan to locate suspicious files and detailed analysis
2. **issue** - Create GitHub issue based on research findings

Your args are: `$ARGUMENTS`

Parse the operation from the args above:
- `research` - Scan codebase and generate detailed report
- `issue` - Create GitHub issue from research results (auto-runs research if not done)

## Operation 1: Research

Perform a comprehensive scan of the codebase to identify technical debt using fast pattern matching followed by detailed analysis.

### Usage

```
research
```

### Workflow

#### Phase 1: Fast Scan

Use fast pattern matching to locate suspicious files. Search in the `turbo/` directory for:

**1. Large Files (>1000 lines)**
```bash
find turbo -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \) \
  -exec wc -l {} + | awk '$1 > 1000 {print $1, $2}' | sort -rn
```

**2. Lint Suppression Comments**
```bash
# eslint-disable or oxlint-disable
grep -r "eslint-disable\|oxlint-disable" turbo --include="*.ts" --include="*.tsx" \
  --include="*.js" --include="*.jsx" -l
```

**3. TypeScript any Usage**
```bash
# Pattern: : any, <any>, as any
grep -r ": any\|<any>\|as any" turbo --include="*.ts" --include="*.tsx" -l
```

**4. Internal Code Mocking (AP-4 Violations)**
```bash
# vi.mock with relative paths
grep -r 'vi\.mock.*\.\./\|vi\.mock.*\.\./' turbo --include="*.test.ts" \
  --include="*.test.tsx" --include="*.spec.ts" -l
```

**5. Fake Timers (AP-5 Violations)**
```bash
grep -r "useFakeTimers\|advanceTimersByTime\|setSystemTime" turbo \
  --include="*.test.ts" --include="*.test.tsx" -l
```

**6. Direct Fetch Mocking (AP-2 Violations)**
```bash
grep -r 'vi\.fn.*fetch\|vi\.stubGlobal.*fetch\|vi\.spyOn.*fetch' turbo \
  --include="*.test.ts" --include="*.test.tsx" -l
```

**7. Filesystem Mocking (AP-3 Violations)**
```bash
grep -r 'vi\.mock.*["\x27]fs["\x27]\|vi\.mock.*["\x27]fs/promises["\x27]' turbo \
  --include="*.test.ts" --include="*.test.tsx" -l
```

**8. Dynamic Imports**
```bash
grep -r "await import\|import(.*)" turbo --include="*.ts" --include="*.tsx" \
  --include="*.js" --include="*.jsx" -l
```

**9. Hardcoded URLs**
```bash
# Pattern: http:// or https:// in strings (exclude comments)
grep -r 'https\?://' turbo --include="*.ts" --include="*.tsx" \
  --include="*.js" --include="*.jsx" | grep -v '^\s*//' | cut -d: -f1 | sort -u
```

**10. Try-Catch Blocks (Defensive Programming)**
```bash
grep -r "try {" turbo --include="*.ts" --include="*.tsx" \
  --include="*.js" --include="*.jsx" -l
```

**11. Fallback Patterns**
```bash
# Pattern: || with fallback values
grep -r "process\.env\.[A-Z_]*\s*||" turbo --include="*.ts" --include="*.tsx" \
  --include="*.js" --include="*.jsx" -l
```

**12. @ts-ignore and @ts-nocheck**
```bash
grep -r "@ts-ignore\|@ts-nocheck\|@ts-expect-error" turbo \
  --include="*.ts" --include="*.tsx" -l
```

**13. Testing Mock Calls (AP-1 Violations)**
```bash
grep -r "toHaveBeenCalled\|toHaveBeenCalledWith" turbo \
  --include="*.test.ts" --include="*.test.tsx" -l
```

**14. Console Mocking Without Assertions (AP-9)**
```bash
grep -r "console\.log\s*=\s*vi\.fn\|console\.error\s*=\s*vi\.fn" turbo \
  --include="*.test.ts" --include="*.test.tsx" -l
```

**15. Missing --max-warnings 0 in Lint Scripts**
```bash
# All lint scripts MUST use --max-warnings 0 to prevent warnings from passing CI
# Find package.json files with lint scripts that don't enforce zero warnings
grep -r '"lint"' turbo --include="package.json" | grep -v "max-warnings 0"
```

**16. ESLint Config "off" Rules (Rule Suppression Audit)**
```bash
# Find rules set to "off" or 0 in ESLint configs — each must be justified
grep -r '"off"\|: 0[,}]' turbo/packages/eslint-config --include="*.js" --include="*.mjs"
# Also check app-level eslint configs
grep -r '"off"\|: 0[,}]' turbo/apps/*/eslint.config.* turbo/packages/*/eslint.config.*
```

**17. Oxlint Config "allow" Rules (Rule Suppression Audit)**
```bash
# Find rules set to "allow" in oxlint configs — each must be justified
# Focus on non-test overrides which are more suspicious
grep -r '"allow"' turbo --include=".oxlintrc.json"
```

**18. Partial Internal Mocks (AP-6 Violations)**
```bash
# vi.importActual is a sign of partial mocking — usually wrong
grep -r 'vi\.importActual' turbo --include="*.test.ts" --include="*.test.tsx" -l
```

**19. Direct Component Rendering (AP-10 Violations)**
```bash
# Platform test files using render() instead of setupPage — misses production bootstrap
grep -r 'render(' turbo/apps/platform --include="*.test.tsx" -l
```

**20. Direct Database Operations in Tests**
```bash
# Tests should use API helpers, not direct DB insert/update/delete
grep -r 'globalThis\.services\.db\.\(insert\|update\|delete\)' turbo \
  --include="*.test.ts" --include="*.test.tsx" -l
```

**21. Tests Importing Internal Services**
```bash
# Test files importing from internal lib/ — means testing implementation, not behavior
grep -rE "from.*['\"].*lib/infra|from.*['\"].*lib/zero" turbo \
  --include="*.test.ts" --include="*.test.tsx" -l
```

**22. initServices() in Tests**
```bash
# Route tests should never call initServices() directly — API helpers handle it
grep -r 'initServices()' turbo --include="*.test.ts" --include="*.test.tsx" -l
```

**23. ccstate-react/experimental in Views (eslint-disable)**
```bash
# Views files suppressing ccstate/no-use-ccstate-in-views — pending migration
grep -rl "eslint-disable ccstate/no-use-ccstate-in-views" turbo/apps/platform/src/views/
```

**24. void Instead of detach() for Floating Promises**
```bash
# Using void to suppress floating promise lint — should use detach() with Reason
grep -rEn 'void [a-zA-Z_$][a-zA-Z0-9_$]*\(' turbo/apps/platform --include="*.ts" --include="*.tsx" -l
```

**25. Manual Loading Boolean in Signals**
```bash
# Manual loading/saving boolean state — should use useLoadableSet or loadable pattern
# Match signal names following the loading$/saving$/submitting$/creating$/deleting$ convention
grep -rEn '\b(loading|saving|submitting|creating|deleting)\$\s*=\s*state\(' turbo/apps/platform/src/signals --include="*.ts" -l
```

**26. Orphaned resetSignal (No Parent Signal)**
```bash
# resetSignal called without parent signal — causes polling loops that never stop
# Match set(resetXxx$) calls with no arguments after the signal name (no comma = no parent)
grep -rEn 'set\(reset[A-Za-z0-9_]*\$\)' turbo/apps/platform/src/signals --include="*.ts"
```

#### Phase 2: Detailed Analysis

For each file identified in Phase 1, perform detailed analysis:

1. **Read the full file content**
2. **Categorize issues** by bad smell type
3. **Calculate severity** (Critical/High/Medium/Low)
4. **Identify specific violations** with line numbers
5. **Suggest remediation** strategies

**Analysis Criteria** (reference from `docs/bad-smell.md` and `docs/testing.md`):

**Testing Anti-Patterns:**
- AP-1: Testing Mock Calls Instead of Behavior
- AP-2: Direct Fetch Mocking (use MSW)
- AP-3: Filesystem Mocking (use real temp directories)
- AP-4: Mocking Internal Code (relative paths)
- AP-5: Fake Timers (vi.useFakeTimers)
- AP-6: Partial Internal Mocks (vi.importActual)
- AP-7: Testing Implementation Details
- AP-8: Over-Testing
- AP-9: Console Mocking Without Assertions
- AP-10: Direct Component Rendering (use setupPage, not render())
- AP-11: Direct Database Operations in Tests (use API helpers)
- AP-12: Importing Internal Services in Tests (tests internal implementation)
- AP-13: initServices() in Tests (API helpers handle it)

**Code Quality Issues:**
- BS-3: Error Handling (unnecessary try/catch)
- BS-4: Interface Changes (breaking changes)
- BS-5: Dynamic Imports (zero tolerance)
- BS-6: Hardcoded URLs and Configuration
- BS-7: Fallback Patterns (fail fast)
- BS-9: TypeScript any Usage
- BS-14: Lint/Type Suppressions
- BS-15: Missing --max-warnings 0 (lint scripts must enforce zero warnings)
- BS-16: ESLint "off" rules (each must be justified, e.g. react-in-jsx-scope is OK)
- BS-17: Oxlint "allow" rules (audit non-test overrides; test-file allows are generally OK)

**ccstate Anti-Patterns:**
- CS-1: ccstate-react/experimental in views (pending migration to signals)
- CS-2: void instead of detach() (floating promises not tracked for cleanup)
- CS-3: Manual loading boolean in signals (use useLoadableSet or loadable pattern)
- CS-4: Orphaned resetSignal without parent (causes polling leaks)
- CS-5: Manual state synchronization (command sets multiple related states — use computed)

**Severity Levels:**
- **Critical (P0)**: Zero-tolerance violations that must be fixed
  - TypeScript `any` usage
  - Lint suppressions (@ts-ignore, eslint-disable)
  - Dynamic imports
  - AP-4: Mocking internal code
  - Missing `--max-warnings 0` in lint scripts
  - Unjustified ESLint "off" rules or oxlint "allow" rules in non-test production code
- **High (P1)**: Significant issues that should be fixed soon
  - Files >1500 lines
  - Defensive programming (unnecessary try/catch)
  - Hardcoded URLs
  - AP-2: Direct fetch mocking
  - AP-3: Filesystem mocking
  - AP-6: Partial internal mocks (vi.importActual)
  - AP-11: Direct database operations in tests
  - AP-12: Importing internal services in tests
  - AP-13: initServices() in tests
  - CS-1: ccstate-react/experimental in views (pending migration)
  - CS-2: void instead of detach() (untracked floating promises)
  - CS-3: Manual loading boolean in signals
  - CS-4: Orphaned resetSignal without parent signal
- **Medium (P2)**: Issues that should be addressed
  - Files >1000 lines
  - Fallback patterns
  - AP-1: Testing mock calls
  - AP-5: Fake timers
  - AP-10: Direct component rendering (use setupPage)
  - CS-5: Manual state synchronization (use computed)
- **Low (P3)**: Minor issues or code smells
  - Over-testing patterns
  - Console mocking without assertions

#### Phase 3: Generate Report

Create detailed report in `/tmp/tech-debt-YYYYMMDD/`:

**Directory Structure:**
```
/tmp/tech-debt-YYYYMMDD/
├── summary.md              # Executive summary
├── statistics.md           # Statistics and metrics
├── critical/               # P0 issues
│   ├── typescript-any.md
│   ├── lint-suppressions.md
│   ├── dynamic-imports.md
│   └── ap4-internal-mocking.md
├── high/                   # P1 issues
│   ├── large-files.md
│   ├── defensive-programming.md
│   ├── hardcoded-urls.md
│   └── fetch-mocking.md
├── medium/                 # P2 issues
│   ├── fallback-patterns.md
│   ├── testing-mock-calls.md
│   └── fake-timers.md
└── low/                    # P3 issues
    ├── over-testing.md
    └── console-mocking.md
```

**File Format for Each Issue:**

```markdown
# [Issue Type] - [Severity]

## Overview
- **Total Files Affected:** {count}
- **Total Violations:** {count}
- **Estimated Effort:** {hours/days}

## Affected Files

### {file-path}
**Lines:** {line-count}
**Violations:** {count}

**Issues:**
1. Line {number}: {description}
   ```typescript
   {code-snippet}
   ```
   **Remediation:** {suggestion}

2. Line {number}: {description}
   ...

---

### {next-file}
...

## Remediation Strategy
{overall-strategy-for-this-issue-type}

## References
- Bad Smell: #{number}
- Testing Anti-Pattern: #{number}
- Related Documentation: {link}
```

**Summary Report Format:**

```markdown
# Technical Debt Analysis Summary

**Scan Date:** {date}
**Scan Scope:** turbo/ directory
**Total Files Scanned:** {count}
**Total Files with Issues:** {count}

## Executive Summary

{2-3 paragraph overview of findings}

## Statistics by Severity

| Severity | Files | Violations | Est. Effort |
|----------|-------|------------|-------------|
| Critical | {n}   | {n}        | {hours}     |
| High     | {n}   | {n}        | {hours}     |
| Medium   | {n}   | {n}        | {hours}     |
| Low      | {n}   | {n}        | {hours}     |
| **Total**| {n}   | {n}        | {hours}     |

## Top Issues

### Critical Issues (Must Fix)
1. **TypeScript any:** {count} files, {violations} violations
2. **Lint Suppressions:** {count} files, {violations} violations
3. **Dynamic Imports:** {count} files, {violations} violations
4. **AP-4 Internal Mocking:** {count} files, {violations} violations
5. **Missing --max-warnings 0:** {count} lint scripts
6. **Unjustified ESLint/oxlint rule suppressions:** {count} rules

### High Priority Issues
1. **Large Files (>1500 lines):** {count} files
2. **Defensive Programming:** {count} files, {violations} try/catch blocks
3. **Hardcoded URLs:** {count} files, {violations} URLs
4. **Direct Fetch Mocking:** {count} test files
5. **Partial Internal Mocks (AP-6):** {count} test files
6. **Direct DB Operations in Tests:** {count} test files
7. **Internal Service Imports in Tests:** {count} test files
8. **initServices() in Tests:** {count} test files
9. **ccstate-react/experimental in Views:** {count} view files
10. **void Instead of detach():** {count} files
11. **Manual Loading Boolean:** {count} signal files
12. **Orphaned resetSignal:** {count} occurrences

### Medium Priority Issues
1. **Fallback Patterns:** {count} files
2. **Testing Mock Calls:** {count} test files
3. **Fake Timers:** {count} test files
4. **Direct Component Rendering (AP-10):** {count} test files
5. **Manual State Synchronization:** {count} signal files

## File Statistics

### Largest Files (Top 10)
1. {file-path} - {lines} lines
2. {file-path} - {lines} lines
...

### Most Violations (Top 10)
1. {file-path} - {count} violations
2. {file-path} - {count} violations
...

## Recommended Action Plan

### Phase 1: Critical Issues (1-2 weeks)
- [ ] Fix all TypeScript any usage
- [ ] Remove all lint suppressions
- [ ] Replace dynamic imports with static
- [ ] Fix AP-4 internal mocking violations
- [ ] Ensure all lint scripts use --max-warnings 0
- [ ] Audit and justify all ESLint "off" / oxlint "allow" rules

### Phase 2: High Priority (2-4 weeks)
- [ ] Refactor files >1500 lines
- [ ] Remove defensive try/catch blocks
- [ ] Replace hardcoded URLs with config
- [ ] Convert fetch mocks to MSW

### Phase 3: Medium Priority (1-2 months)
- [ ] Remove fallback patterns
- [ ] Fix testing mock call assertions
- [ ] Replace fake timers

### Phase 4: Low Priority (ongoing)
- [ ] Address over-testing patterns
- [ ] Clean up console mocking

## Detailed Reports

- [Critical Issues](./critical/)
- [High Priority Issues](./high/)
- [Medium Priority Issues](./medium/)
- [Low Priority Issues](./low/)

---
*Generated by tech-debt skill on {date}*
```

#### Phase 4: User Report

After generating detailed reports, provide a **medium-detail summary** to the user:

```markdown
# Technical Debt Scan Complete

## Scan Results

**Total Files Scanned:** {count}
**Files with Issues:** {count}
**Total Violations:** {count}

## By Severity

- **Critical (P0):** {count} files, {violations} violations
- **High (P1):** {count} files, {violations} violations
- **Medium (P2):** {count} files, {violations} violations
- **Low (P3):** {count} files, {violations} violations

## Top 5 Critical Issues

1. **TypeScript any** - {count} files
   - {file-path}:{line} - {brief-description}
   - {file-path}:{line} - {brief-description}

2. **Lint Suppressions** - {count} files
   - {file-path}:{line} - {brief-description}
   - {file-path}:{line} - {brief-description}

3. **Dynamic Imports** - {count} files
   - {file-path}:{line} - {brief-description}

4. **AP-4 Internal Mocking** - {count} files
   - {file-path}:{line} - {brief-description}

5. **Large Files** - {count} files
   - {file-path} - {lines} lines
   - {file-path} - {lines} lines

## Detailed Reports

All detailed analysis has been saved to `/tmp/tech-debt-{date}/`

- Summary: `/tmp/tech-debt-{date}/summary.md`
- Statistics: `/tmp/tech-debt-{date}/statistics.md`
- Critical issues: `/tmp/tech-debt-{date}/critical/`
- High priority: `/tmp/tech-debt-{date}/high/`

## Next Steps

Run `tech-debt issue` to create a GitHub issue tracking these findings.
```

### Implementation Notes

**Efficiency Tips:**
- Use `grep -l` (files only) for fast scanning
- Use `wc -l` for line counts
- Combine multiple greps with parallel execution
- Only read files that match patterns
- Cache scan results for issue operation

**Accuracy Tips:**
- Exclude `node_modules` and `.git` directories
- Exclude generated files (*.d.ts)
- Exclude migration files for some checks
- Use word boundaries in regex (`\b`) for precision
- Verify matches by reading actual file content

---

## Operation 2: Issue

Create a GitHub issue based on research findings. If research hasn't been run, automatically run it first.

### Usage

```
issue
```

### Workflow

#### Step 1: Check for Existing Research

```bash
# Check if research was already done today
LATEST_REPORT=$(ls -td /tmp/tech-debt-* 2>/dev/null | head -1)

if [ -z "$LATEST_REPORT" ]; then
  echo "No research found. Running research first..."
  # Run research operation
else
  echo "Using existing research from: $LATEST_REPORT"
fi
```

#### Step 2: Prepare Issue Content

Read research reports and prepare GitHub issue content:

**Issue Title:**
```
[Tech Debt] Codebase Quality Scan - {date}
```

**Issue Body Structure:**

```markdown
# Technical Debt Analysis - {date}

This issue tracks technical debt identified through automated codebase scanning.

## Executive Summary

{paste-from-summary.md}

## Statistics

{paste-from-statistics.md}

## Critical Issues (P0) - Must Fix

{paste-critical-issues-summary}

<details>
<summary>Detailed Critical Issues</summary>

{paste-from-critical/*.md}

</details>

## High Priority Issues (P1)

{paste-high-issues-summary}

<details>
<summary>Detailed High Priority Issues</summary>

{paste-from-high/*.md}

</details>

## Medium Priority Issues (P2)

{paste-medium-issues-summary}

<details>
<summary>Detailed Medium Priority Issues</summary>

{paste-from-medium/*.md}

</details>

## Action Plan

### Phase 1: Critical Issues (Target: 1-2 weeks)
- [ ] Fix TypeScript any usage ({count} files)
- [ ] Remove lint suppressions ({count} files)
- [ ] Replace dynamic imports ({count} files)
- [ ] Fix internal mocking violations ({count} files)
- [ ] Ensure all lint scripts use --max-warnings 0 ({count} scripts)
- [ ] Audit ESLint "off" / oxlint "allow" rules ({count} rules)

### Phase 2: High Priority (Target: 2-4 weeks)
- [ ] Refactor large files ({count} files)
- [ ] Remove defensive programming ({count} blocks)
- [ ] Replace hardcoded URLs ({count} files)
- [ ] Convert fetch mocks to MSW ({count} files)
- [ ] Remove vi.importActual usage ({count} files)
- [ ] Replace direct DB operations in tests with API helpers ({count} files)
- [ ] Remove internal service imports from tests ({count} files)
- [ ] Remove initServices() from tests ({count} files)
- [ ] Migrate ccstate-react/experimental out of views ({count} files)
- [ ] Replace void with detach() ({count} files)
- [ ] Replace manual loading booleans with useLoadableSet ({count} files)
- [ ] Fix orphaned resetSignal calls ({count} occurrences)

### Phase 3: Medium Priority (Target: 1-2 months)
- [ ] Remove fallback patterns ({count} files)
- [ ] Fix testing mock assertions ({count} files)
- [ ] Replace fake timers ({count} files)
- [ ] Replace direct component rendering with setupPage ({count} files)
- [ ] Refactor manual state synchronization to computed ({count} files)

## Labels

`tech-debt` `quality` `refactoring`

---

**Scan Details:**
- Date: {date}
- Scope: turbo/ directory
- Total files scanned: {count}
- Total violations: {count}

**References:**
- Bad Smell Documentation: `/docs/bad-smell.md`
- Testing Guidelines: `/docs/testing.md`
```

#### Step 3: Create GitHub Issue

**Single Issue Strategy:**

If total content is under GitHub issue size limit (~65K characters):

```bash
gh issue create \
  --title "[Tech Debt] Codebase Quality Scan - $(date +%Y-%m-%d)" \
  --body-file /tmp/tech-debt-{date}/github-issue-body.md \
  --label "tech-debt,quality,refactoring"
```

**Multiple Comments Strategy:**

If content exceeds size limit, create issue with summary and post detailed sections as comments:

```bash
# 1. Create issue with executive summary
ISSUE_URL=$(gh issue create \
  --title "[Tech Debt] Codebase Quality Scan - $(date +%Y-%m-%d)" \
  --body-file /tmp/tech-debt-{date}/github-issue-summary.md \
  --label "tech-debt,quality,refactoring")

ISSUE_NUMBER=$(echo $ISSUE_URL | grep -oP '\d+$')

# 2. Post critical issues as comment
gh issue comment $ISSUE_NUMBER \
  --body-file /tmp/tech-debt-{date}/github-comment-critical.md

# 3. Post high priority issues as comment
gh issue comment $ISSUE_NUMBER \
  --body-file /tmp/tech-debt-{date}/github-comment-high.md

# 4. Post medium priority issues as comment
gh issue comment $ISSUE_NUMBER \
  --body-file /tmp/tech-debt-{date}/github-comment-medium.md

# 5. Post action plan as comment
gh issue comment $ISSUE_NUMBER \
  --body-file /tmp/tech-debt-{date}/github-comment-action-plan.md
```

**Comment Size Limits:**
- Each comment should be <65K characters
- If a section exceeds limit, split into multiple comments
- Use clear headers to indicate which part of the report each comment contains

#### Step 4: Report to User

```markdown
# GitHub Issue Created

**Issue URL:** {url}
**Issue Number:** #{number}

## Content Posted

✅ Issue created with executive summary
✅ Posted {n} comments with detailed findings

## Issue Structure

- Main issue: Executive summary and statistics
- Comment 1: Critical Issues (P0)
- Comment 2: High Priority Issues (P1)
- Comment 3: Medium Priority Issues (P2)
- Comment 4: Action Plan

## Next Steps

1. Review the GitHub issue
2. Prioritize which issues to tackle first
3. Create separate issues for specific refactoring tasks if needed
4. Track progress using the checklist in the action plan

## Local Reports

Detailed reports are also available in:
`/tmp/tech-debt-{date}/`
```

### Implementation Notes

**GitHub CLI Usage:**
- Use `gh issue create` to create issues
- Use `gh issue comment` to add comments
- Verify gh is authenticated: `gh auth status`
- Use `--body-file` for large content if needed

**Content Preparation:**
- Inline all report content (don't use file links)
- Use markdown collapsible sections (`<details>`) for long content
- Include syntax highlighting for code snippets
- Add line breaks for readability

**Error Handling:**
- Check if gh CLI is installed and authenticated
- Verify issue creation succeeded before posting comments
- If comment posting fails, save remaining content to file and report to user
- Don't fail entire operation if one comment fails

---

## General Guidelines

### Scanning Principles

1. **Comprehensive Coverage**
   - Scan all source files in turbo/ directory
   - Include both production and test code
   - Don't skip any file types (.ts, .tsx, .js, .jsx)

2. **Efficient Execution**
   - Use fast pattern matching first (grep, find)
   - Only read files that match patterns
   - Run searches in parallel when possible
   - Cache results between operations

3. **Accurate Analysis**
   - Read full file content for matched files
   - Verify patterns in context
   - Avoid false positives
   - Include line numbers for all findings

4. **Actionable Reporting**
   - Provide specific file paths and line numbers
   - Include code snippets for context
   - Suggest concrete remediation steps
   - Estimate effort for fixes

### Quality Standards

**Zero Tolerance Issues (P0):**
- TypeScript `any` usage
- Lint suppressions (@ts-ignore, eslint-disable)
- Dynamic imports
- Mocking internal code (AP-4)
- Missing `--max-warnings 0` in lint scripts
- Unjustified ESLint "off" / oxlint "allow" rules in production code

**High Priority Issues (P1):**
- Files >1500 lines
- Defensive programming patterns
- Hardcoded URLs
- Direct fetch mocking (AP-2)
- Filesystem mocking (AP-3)
- Partial internal mocks (AP-6)
- Direct database operations in tests (AP-11)
- Importing internal services in tests (AP-12)
- initServices() in tests (AP-13)
- ccstate-react/experimental in views (CS-1)
- void instead of detach() (CS-2)
- Manual loading boolean in signals (CS-3)
- Orphaned resetSignal without parent (CS-4)

**Medium Priority Issues (P2):**
- Files >1000 lines
- Fallback patterns
- Testing mock calls (AP-1)
- Fake timers (AP-5)
- Direct component rendering (AP-10)
- Manual state synchronization (CS-5)

**Low Priority Issues (P3):**
- Over-testing patterns
- Console mocking without assertions

### Communication Style

**To User:**
- Medium level of detail (not too brief, not overwhelming)
- Focus on most important findings
- Provide clear next steps
- Use markdown formatting

**In Reports:**
- High level of detail
- Include all findings with evidence
- Provide remediation guidance
- Use consistent formatting

**In GitHub Issues:**
- Balance detail with readability
- Use collapsible sections for long content
- Include actionable checklists
- Add appropriate labels

---

## Error Handling

When encountering errors:
- If grep/find fails, report and continue with other checks
- If file is unreadable, note it and continue
- If directory doesn't exist, report and skip
- If gh CLI fails, report and save content to file
- Always complete scan even if some steps fail
- Provide partial results if full scan can't complete

---

## Example Usage

```
# Run research scan
args: "research"

# Create GitHub issue from research
args: "issue"
```

---

## References

- Bad smell documentation: `/docs/bad-smell.md`
- Testing anti-patterns: `/docs/testing.md`
- Testing anti-patterns catalog: `/docs/testing/anti-patterns.md`
- API route testing patterns: `/docs/testing/api-testing.md`
- App testing patterns: `/docs/testing/app-testing.md`
- ccstate patterns: `/.claude/skills/ccstate/SKILL.md`
- Code quality skill: `/.claude/skills/code-quality/SKILL.md`
- Project principles: `/CLAUDE.md`
