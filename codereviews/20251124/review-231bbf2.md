# Review: feat: refactor issue commands for flexibility and intelligence

**Commit:** 231bbf2
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Sun Nov 23 23:22:18 2025 +0800

## Summary

This commit refactors the issue creation command system to be more flexible and principle-driven rather than template-based. The changes split functionality into three specialized commands:

**New specialized commands:**

- `issue-feature`: Create feature requests focused on user requirements and acceptance criteria
- `issue-bug`: Create bug reports with reproduction steps and environment details
- `issue-new`: Intelligently analyze conversation context to determine issue type automatically

**Key improvements:**

- Remove rigid templates in favor of principle-based guidance
- Allow Agent to organize content naturally based on conversation context
- Mandatory clarification step ensures accuracy before creation
- Flexible labeling based on actual content
- Use Conventional Commit format for issue titles (feat:, bug:, docs:, refactor:, etc.)
- Increased Agent autonomy while maintaining quality

**Files affected:** 3 files changed, 320 insertions(+), 49 deletions(-)

- New files: `issue-bug.md` (88 lines), `issue-feature.md` (83 lines)
- Modified: `issue-new.md` (comprehensive refactor, 198 lines vs 49 lines)

## Code Smell Analysis

### ✅ Good Practices

- **Principle-based design**: Uses clear, actionable principles instead of rigid templates
- **Agent autonomy**: Increases flexibility while maintaining quality through guidelines
- **Consistent conventions**: Applies Conventional Commit format for all issue titles
- **Comprehensive guidance**: Each command includes clear workflow, core principles, and flexibility notes
- **No code smells**: These are markdown command files with process guidelines, not executable code
- **Sensible defaults**: Provides appropriate labels and title formats while allowing customization
- **Clarification workflow**: Mandatory user clarification step prevents misunderstandings

### ⚠️ Issues Found

**None identified.** These are well-structured command documentation files without executable code.

The refactor properly:

- Replaces rigid templates with principle-based guidance
- Maintains quality through clear, actionable principles
- Provides flexibility while keeping consistency via Conventional Commits
- No defensive programming patterns
- No artificial complexity or over-engineering
- No unnecessary abstractions (YAGNI principle respected)

### 💡 Recommendations

**No code changes needed.** This is a process improvement that provides better guidance for the Claude Code Agent.

**Optional enhancements for future consideration:**

1. Document how the three commands relate to each other in a README or guide
2. Add examples of common issue types for each command to help users select the right one
3. Consider creating a decision tree if Agent autonomy in `issue-new` needs additional guidance

**Process note:**
The removal of the preview step in `issue-new` (now creates issues directly after clarification) increases efficiency and reduces friction. This is a good UX improvement.

## Breaking Changes

**Workflow Changes:**

1. **`issue-new` command now auto-determines issue type** instead of requiring user to specify
   - No user-facing breaking change since it now works automatically
   - Users no longer see a preview before creation (increased efficiency)

2. **Three commands instead of one** (though backwards compatible since `issue-new` still exists)
   - Users can now explicitly use `issue-feature` or `issue-bug` for typed issues
   - `issue-new` intelligently chooses the appropriate command
   - This is an enhancement, not a breaking change

3. **Issue titles now require Conventional Commit format**
   - All issues now follow: `<type>: <lowercase description>` (no period)
   - This is a consistency improvement, not a breaking change to functionality

**Compatibility:**

- No breaking changes to APIs or data structures
- Purely a process/workflow improvement
- Existing integrations continue to work as before
- Only changes are to how issues are created and structured
