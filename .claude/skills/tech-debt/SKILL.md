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

Parse the operation from the `args` parameter:
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

#### Phase 2: Detailed Analysis

For each file identified in Phase 1, perform detailed analysis:

1. **Read the full file content**
2. **Categorize issues** by bad smell type
3. **Calculate severity** (Critical/High/Medium/Low)
4. **Identify specific violations** with line numbers
5. **Suggest remediation** strategies

**Analysis Criteria** (reference from `specs/bad-smell.md` and `.claude/skills/testing/SKILL.md`):

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
- AP-10: Direct Component Rendering

**Code Quality Issues:**
- BS-3: Error Handling (unnecessary try/catch)
- BS-4: Interface Changes (breaking changes)
- BS-5: Dynamic Imports (zero tolerance)
- BS-6: Hardcoded URLs and Configuration
- BS-7: Fallback Patterns (fail fast)
- BS-9: TypeScript any Usage
- BS-14: Lint/Type Suppressions

**Severity Levels:**
- **Critical (P0)**: Zero-tolerance violations that must be fixed
  - TypeScript `any` usage
  - Lint suppressions (@ts-ignore, eslint-disable)
  - Dynamic imports
  - AP-4: Mocking internal code
- **High (P1)**: Significant issues that should be fixed soon
  - Files >1500 lines
  - Defensive programming (unnecessary try/catch)
  - Hardcoded URLs
  - AP-2: Direct fetch mocking
  - AP-3: Filesystem mocking
- **Medium (P2)**: Issues that should be addressed
  - Files >1000 lines
  - Fallback patterns
  - AP-1: Testing mock calls
  - AP-5: Fake timers
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

### High Priority Issues
1. **Large Files (>1500 lines):** {count} files
2. **Defensive Programming:** {count} files, {violations} try/catch blocks
3. **Hardcoded URLs:** {count} files, {violations} URLs
4. **Direct Fetch Mocking:** {count} test files

### Medium Priority Issues
1. **Fallback Patterns:** {count} files
2. **Testing Mock Calls:** {count} test files
3. **Fake Timers:** {count} test files

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

### Phase 2: High Priority (Target: 2-4 weeks)
- [ ] Refactor large files ({count} files)
- [ ] Remove defensive programming ({count} blocks)
- [ ] Replace hardcoded URLs ({count} files)
- [ ] Convert fetch mocks to MSW ({count} files)

### Phase 3: Medium Priority (Target: 1-2 months)
- [ ] Remove fallback patterns ({count} files)
- [ ] Fix testing mock assertions ({count} files)
- [ ] Replace fake timers ({count} files)

## Labels

`tech-debt` `quality` `refactoring`

---

**Scan Details:**
- Date: {date}
- Scope: turbo/ directory
- Total files scanned: {count}
- Total violations: {count}

**References:**
- Bad Smell Documentation: `/specs/bad-smell.md`
- Testing Guidelines: `/.claude/skills/testing/SKILL.md`
```

#### Step 3: Create GitHub Issue

**Single Issue Strategy:**

If total content is under GitHub issue size limit (~65K characters):

```bash
gh issue create \
  --title "[Tech Debt] Codebase Quality Scan - $(date +%Y-%m-%d)" \
  --body "$(cat /tmp/tech-debt-{date}/github-issue-body.md)" \
  --label "tech-debt,quality,refactoring"
```

**Multiple Comments Strategy:**

If content exceeds size limit, create issue with summary and post detailed sections as comments:

```bash
# 1. Create issue with executive summary
ISSUE_URL=$(gh issue create \
  --title "[Tech Debt] Codebase Quality Scan - $(date +%Y-%m-%d)" \
  --body "$(cat /tmp/tech-debt-{date}/github-issue-summary.md)" \
  --label "tech-debt,quality,refactoring")

ISSUE_NUMBER=$(echo $ISSUE_URL | grep -oP '\d+$')

# 2. Post critical issues as comment
gh issue comment $ISSUE_NUMBER \
  --body "$(cat /tmp/tech-debt-{date}/github-comment-critical.md)"

# 3. Post high priority issues as comment
gh issue comment $ISSUE_NUMBER \
  --body "$(cat /tmp/tech-debt-{date}/github-comment-high.md)"

# 4. Post medium priority issues as comment
gh issue comment $ISSUE_NUMBER \
  --body "$(cat /tmp/tech-debt-{date}/github-comment-medium.md)"

# 5. Post action plan as comment
gh issue comment $ISSUE_NUMBER \
  --body "$(cat /tmp/tech-debt-{date}/github-comment-action-plan.md)"
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

**High Priority Issues (P1):**
- Files >1500 lines
- Defensive programming patterns
- Hardcoded URLs
- Direct fetch mocking (AP-2)
- Filesystem mocking (AP-3)

**Medium Priority Issues (P2):**
- Files >1000 lines
- Fallback patterns
- Testing mock calls (AP-1)
- Fake timers (AP-5)

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

- Bad smell documentation: `/specs/bad-smell.md`
- Testing anti-patterns: `/.claude/skills/testing/SKILL.md`
- Code quality skill: `/.claude/skills/code-quality/SKILL.md`
- Project principles: `/CLAUDE.md`
