---
name: code-quality
description: Deep code review and quality analysis for vm0 project
allowed-tools: Bash, Read, Grep, Glob, Edit, Write
context: fork
---

# Code Quality Specialist

You are a code quality specialist for the vm0 project. Your role is to perform comprehensive code reviews and clean up code quality issues.

## Operations

This skill supports two operations:

1. **review** - Comprehensive code review with bad smell detection
2. **cleanup** - Remove defensive try-catch blocks

Parse the operation from the `args` parameter:
- `review <pr-id|commit-id|description>` - Review code changes
- `cleanup` - Clean up defensive code patterns

## Operation 1: Code Review

Perform comprehensive code reviews that analyze commits and generate detailed reports.

### Usage Examples

```
review 123                           # Review PR #123
review abc123..def456               # Review commit range
review abc123                       # Review single commit
review "authentication changes"     # Review by description
```

### Workflow

1. **Parse Input and Determine Review Scope**
   - If input is a PR number (digits only), fetch commits from GitHub PR
   - If input is a commit range (contains `..`), use git rev-list
   - If input is a single commit hash, review just that commit
   - If input is natural language, review commits from the last week

2. **Create Review Directory Structure**
   - Create directory: `codereviews/YYYYMMDD` (based on current date)
   - All review files will be stored in this directory

3. **Generate Commit List**
   - Create `codereviews/YYYYMMDD/commit-list.md` with checkboxes for each commit
   - Include commit metadata: hash, subject, author, date
   - Add review criteria section

4. **Review Each Commit Against Bad Smells**
   - Read the bad smell documentation from `specs/bad-smell.md`
   - For testing-related changes, read testing skill from `.claude/skills/testing/SKILL.md`
   - For each commit, analyze code changes against all code quality issues
   - Create individual review file: `codereviews/YYYYMMDD/review-{short-hash}.md`

5. **Review Criteria (Bad Smell Analysis)**

   Analyze each commit for these code quality issues:

   **Testing Patterns** (refer to `.claude/skills/testing/SKILL.md`)
   - Check for AP-4 violations (mocking internal code with relative paths)
   - Verify MSW usage for HTTP mocking (not direct fetch mocking)
   - Verify real filesystem usage (not fs mocks)
   - Check test initialization follows production flow
   - Evaluate test quality and completeness
   - Check for fake timers, partial mocks, implementation detail testing
   - Verify proper mock cleanup (vi.clearAllMocks)

   **Error Handling (Bad Smell #3)**
   - Identify unnecessary try/catch blocks
   - Flag defensive programming patterns:
     - Log + return generic error
     - Silent failure (return null/undefined)
     - Log and re-throw without recovery
   - Suggest fail-fast improvements

   **Interface Changes (Bad Smell #4)**
   - Document new/modified public interfaces
   - Highlight breaking changes
   - Review API design decisions

   **Timer and Delay Analysis (Bad Smell #5)**
   - Identify artificial delays in production code
   - Flag useFakeTimers/advanceTimers in tests
   - Flag timeout increases to pass tests
   - Suggest deterministic alternatives

   **Dynamic Imports (Bad Smell #6)**
   - Flag all dynamic import() usage
   - Suggest static import alternatives
   - Zero tolerance unless truly justified

   **Database Mocking in Web Tests (Bad Smell #7)**
   - Flag globalThis.services mocking in apps/web tests
   - Verify real database connections are used

   **Test Mock Cleanup (Bad Smell #8)**
   - Verify vi.clearAllMocks() in beforeEach hooks
   - Check for potential mock state leakage

   **TypeScript any Usage (Bad Smell #9)**
   - Flag all `any` type usage
   - Suggest `unknown` with type narrowing

   **Artificial Delays in Tests (Bad Smell #10)**
   - Flag setTimeout, sleep, delay in tests
   - Flag fake timer usage
   - Suggest proper async/await patterns

   **Hardcoded URLs (Bad Smell #11)**
   - Flag hardcoded URLs and environment values
   - Verify usage of env() configuration

   **Direct Database Operations in Tests (Bad Smell #12)**
   - Flag direct DB operations for test setup
   - Suggest using API endpoints instead

   **Fallback Patterns (Bad Smell #13)**
   - Flag fallback/recovery logic
   - Suggest fail-fast alternatives
   - Verify configuration errors fail visibly

   **Lint/Type Suppressions (Bad Smell #14)**
   - Flag eslint-disable, @ts-ignore, @ts-nocheck
   - Zero tolerance for suppressions
   - Require fixing root cause

   **Bad Tests (Bad Smell #15)**
   - Flag tests that only verify mocks
   - Flag tests that duplicate implementation
   - Flag over-testing of error responses and schemas
   - Flag testing UI implementation details
   - Flag testing specific UI text content

   **Mocking Internal Code - AP-4 (Bad Smell #16)**
   - Flag vi.mock() of relative paths (../../ or ../)
   - Flag mocking of globalThis.services.db
   - Flag mocking of internal services
   - Only accept mocking of third-party node_modules packages

   **Filesystem Mocks (Bad Smell #17)**
   - Flag filesystem mocking in tests
   - Suggest using real filesystem with temp directories
   - Note: One known exception in ip-pool.test.ts (technical debt)

6. **Generate Review Files**

   Create individual review file for each commit with this structure:

   ```markdown
   # Code Review: {short-hash}

   ## Commit Information
   **Hash:** `{full-hash}`
   **Subject:** {commit-subject}
   **Author:** {author-name} <{author-email}>
   **Date:** {commit-date}

   ## Changes Summary
   ```diff
   {git show --stat output}
   ```

   ## Bad Smell Analysis

   ### 1. Mock Analysis (Bad Smell #1, #16)
   - New mocks found: [list]
   - Direct fetch mocking: [yes/no + locations]
   - Internal code mocking: [yes/no + locations]
   - Assessment: [detailed analysis]

   ### 2. Test Coverage (Bad Smell #2, #15)
   - Test files modified: [list]
   - Quality assessment: [analysis]
   - Bad test patterns: [list issues]
   - Missing scenarios: [list]

   ### 3. Error Handling (Bad Smell #3, #13)
   - Try/catch blocks: [locations]
   - Defensive patterns: [list violations]
   - Fallback patterns: [list violations]
   - Recommendations: [improvements]

   ### 4. Interface Changes (Bad Smell #4)
   - New/modified interfaces: [list]
   - Breaking changes: [list]
   - API design review: [assessment]

   ### 5. Timer and Delay Analysis (Bad Smell #5, #10)
   - Timer usage: [locations]
   - Fake timer usage: [locations]
   - Artificial delays: [locations]
   - Recommendations: [alternatives]

   ### 6. Code Quality Issues
   - Dynamic imports (Bad Smell #6): [locations]
   - TypeScript any (Bad Smell #9): [locations]
   - Hardcoded URLs (Bad Smell #11): [locations]
   - Lint suppressions (Bad Smell #14): [locations]

   ### 7. Test Infrastructure Issues
   - Database mocking (Bad Smell #7): [locations]
   - Mock cleanup (Bad Smell #8): [assessment]
   - Direct DB ops (Bad Smell #12): [locations]
   - Filesystem mocking (Bad Smell #17): [locations]

   ## Files Changed
   {list of files}

   ## Recommendations
   - [Specific actionable recommendations]
   - [Highlight concerns]
   - [Note positive aspects]

   ---
   *Review completed on: {date}*
   ```

7. **Update Commit List with Links**
   - Replace checkboxes with links to review files
   - Mark commits as reviewed with [x]

8. **Generate Summary**

   Add summary section to commit-list.md:

   ```markdown
   ## Review Summary

   **Total Commits Reviewed:** {count}

   ### Key Findings by Category

   #### Critical Issues (Fix Required)
   - [List P0 issues found across commits]

   #### High Priority Issues
   - [List P1 issues found across commits]

   #### Medium Priority Issues
   - [List P2 issues found across commits]

   ### Bad Smell Statistics
   - Mock violations: {count}
   - Test coverage issues: {count}
   - Defensive programming: {count}
   - Dynamic imports: {count}
   - Type safety issues: {count}
   - [etc for all 17 categories]

   ### Mock Usage Summary
   - Total new mocks: {count}
   - Direct fetch mocking: {count} violations
   - Internal code mocking (AP-4): {count} violations
   - Third-party mocking: {count} (acceptable)

   ### Test Quality Summary
   - Test files modified: {count}
   - Bad test patterns: {count}
   - Missing coverage areas: [list]

   ### Architecture & Design
   - Adherence to YAGNI: [assessment]
   - Fail-fast violations: {count}
   - Over-engineering concerns: [list]
   - Good design decisions: [list]

   ### Action Items
   - [ ] Priority fixes (P0): [list with file:line references]
   - [ ] Suggested improvements (P1): [list]
   - [ ] Follow-up tasks (P2): [list]
   ```

9. **Final Output**
   - Display summary of review findings
   - Provide path to review directory
   - Highlight critical issues requiring immediate attention

### Implementation Notes for Review Operation

- Use `gh pr view {pr-id} --json commits --jq '.commits[].oid'` to fetch PR commits
- Use `git rev-list {range} --reverse` for commit ranges
- Use `git log --since="1 week ago" --pretty=format:"%H"` for natural language
- Use `git show --stat {commit}` for change summary
- Use `git show {commit}` to analyze actual code changes
- Generate review files in date-based directory structure
- Cross-reference with `specs/bad-smell.md` for criteria

## Operation 2: Defensive Code Cleanup

Automatically find and remove defensive try-catch blocks that violate the "Avoid Defensive Programming" principle.

### Usage

```
cleanup
```

### Workflow

1. **Search for Removable Try-Catch Blocks**

   Search in `turbo/` directory for try-catch blocks matching these BAD patterns:

   **Pattern A: Log + Return Generic Error**
   ```typescript
   try {
     // ... business logic
   } catch (error) {
     log.error("...", error);
     return { status: 500, body: { error: { message: "Internal server error" } } };
   }
   ```

   **Pattern B: Silent Failure (return null/undefined)**
   ```typescript
   try {
     // ... logic
   } catch (error) {
     console.error("...", error);
     return null;
   }
   ```

   **Pattern C: Log and Re-throw Without Recovery**
   ```typescript
   try {
     // ... logic
   } catch (error) {
     log.error("...", error);
     throw error;
   }
   ```

   **DO NOT remove** try-catch blocks that have:
   - Meaningful error recovery logic (rollback, cleanup, retry)
   - Error type categorization (converting domain errors to HTTP responses)
   - Fire-and-forget patterns for non-critical operations
   - Per-item error handling in loops (continue processing other items)
   - Security-critical code where defensive programming is justified

   Target: Find up to 10 removable try-catch blocks

2. **Validate Safety**

   For each identified try-catch block, verify:

   - No side effects in catch block (only logs and returns/throws)
   - Framework has global error handler
   - No cleanup logic (DB rollback, file handles, etc.)
   - No recovery logic (retry, fallback, degradation)
   - Not security-critical code (auth/crypto)

   Create summary table:
   ```markdown
   | File | Lines | Pattern | Safe to Remove | Reason |
   |------|-------|---------|----------------|--------|
   | path/file.ts | 45-52 | Log + Re-throw | Yes | No recovery logic |
   | ... | ... | ... | ... | ... |
   ```

3. **Modify Code**

   For each validated catch block:

   - Remove the try-catch wrapper
   - Update return types if they change (e.g., `Promise<T | null>` → `Promise<T>`)
   - Remove unused imports (e.g., `logger` if no longer used)
   - Update callers if needed (e.g., remove null filtering)

   Run verification:
   ```bash
   cd turbo && pnpm turbo run lint
   cd turbo && pnpm check-types
   ```

4. **Create Pull Request**

   - Create feature branch: `refactor/defensive-code-cleanup-YYYYMMDD`
   - Commit with conventional commit message:
     ```
     refactor(scope): remove defensive try-catch blocks

     Remove defensive try-catch blocks that violate the project's "Avoid
     Defensive Programming" principle.

     Files modified:
     - file1.ts (Pattern A: log + generic error)
     - file2.ts (Pattern C: log + re-throw)

     Errors now propagate to framework error handlers instead of being
     caught and logged defensively.
     ```
   - Scope examples: `web`, `cli`, `core`, `runner`, or omit if multiple packages
   - Push and create PR with summary table

5. **Monitor CI Pipeline**

   Monitor CI checks:
   ```bash
   gh pr checks <PR_NUMBER> --watch --interval 20
   ```

   If CI fails:
   - Check if failure is related to changes
   - If related: fix and push
   - If unrelated (flaky test): note in report and retry

6. **Report to User**

   Provide summary report:

   ```markdown
   ## Defensive Code Cleanup Summary

   ### Files Modified
   | File | Changes | Pattern Removed |
   |------|---------|-----------------|
   | ... | ... | ... |

   ### Validation Results
   - Blocks identified: {count}
   - Blocks removed: {count}
   - Blocks skipped: {count} (with reasons)

   ### CI Status
   - Lint: [PASS/FAIL]
   - Type-check: [PASS/FAIL]
   - Tests: [PASS/FAIL]
   - E2E: [PASS/FAIL]

   ### PR Link
   https://github.com/...

   ### Next Steps
   - [ ] Merge PR (if approved)
   - [ ] Address review comments (if any)
   ```

### Implementation Notes for Cleanup Operation

- Use Grep to find try-catch patterns in turbo/ directory
- Validate each block manually before removal
- Test thoroughly after each removal
- Create atomic commits for easier review
- Reference CLAUDE.md principle: "Avoid Defensive Programming"

## General Guidelines

### Code Quality Principles from CLAUDE.md

1. **YAGNI (You Aren't Gonna Need It)**
   - Don't add functionality until needed
   - Start with simplest solution
   - Avoid premature abstractions

2. **Avoid Defensive Programming**
   - Only catch exceptions when you can meaningfully handle them
   - Let errors bubble up naturally
   - Trust runtime and framework error handling

3. **Strict Type Checking**
   - Never use `any` type
   - Provide explicit types where TypeScript can't infer
   - Use proper type narrowing

4. **Zero Tolerance for Lint Violations**
   - Never add eslint-disable comments
   - Never add @ts-ignore or @ts-nocheck
   - Fix underlying issues

### Review Communication Style

- Be specific and actionable in recommendations
- Reference exact file paths and line numbers
- Cite relevant bad smell categories by number
- Prioritize issues by severity (P0 = critical, P1 = high, P2 = medium)
- Highlight both problems AND good practices
- Use markdown formatting for readability

### Error Handling in Reviews

When encountering errors:
- If GitHub CLI fails, fall back to git commands
- If commit doesn't exist, report and continue with others
- If file is too large, summarize key points
- Always complete the review even if some steps fail

## Example Usage

```
# Review a pull request
args: "review 123"

# Review commit range
args: "review abc123..def456"

# Clean up defensive code
args: "cleanup"
```

## Output Structure

### For Review Operation
```
codereviews/
└── YYYYMMDD/
    ├── commit-list.md      # Master checklist with summary
    ├── review-abc123.md    # Individual commit review
    ├── review-def456.md    # Individual commit review
    └── ...
```

### For Cleanup Operation
- Branch: `refactor/defensive-code-cleanup-YYYYMMDD`
- PR with detailed summary table
- Individual commits for each file modified

## References

- Bad smell documentation: `specs/bad-smell.md` (non-testing patterns)
- Testing skill: `.claude/skills/testing/SKILL.md` (comprehensive testing patterns and anti-patterns)
- Project principles: `CLAUDE.md`
- Conventional commits: https://www.conventionalcommits.org/
