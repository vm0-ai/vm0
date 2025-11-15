#!/bin/bash

set -e

# Code Review Implementation Script
# This script handles the automated code review workflow

# Get current date in YYYYMMDD format
CURRENT_DATE=$(date +"%Y%m%d")
REVIEW_DIR="codereviews/$CURRENT_DATE"
COMMIT_LIST_FILE="$REVIEW_DIR/commit-list.md"

# Create review directory
mkdir -p "$REVIEW_DIR"

# Function to detect input type and generate commit list
generate_commit_list() {
    local input="$1"
    local commits=()

    echo "# Code Review Commit List" > "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "Generated on: $(date)" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    # Check if input is a PR number
    if [[ "$input" =~ ^[0-9]+$ ]]; then
        echo "Detected PR ID: $input" >&2
        echo "**Review Type:** GitHub PR #$input" >> "$COMMIT_LIST_FILE"
        echo "" >> "$COMMIT_LIST_FILE"

        # Get commits from PR using GitHub CLI
        if command -v gh &> /dev/null; then
            gh pr view "$input" --json commits --jq '.commits[].oid' > /tmp/pr_commits.txt 2>/dev/null || {
                echo "Error: Could not fetch PR $input. Using recent commits instead." >&2
                git log --oneline -10 --pretty=format:"%H" > /tmp/pr_commits.txt
            }
        else
            echo "GitHub CLI not available. Using recent commits." >&2
            git log --oneline -10 --pretty=format:"%H" > /tmp/pr_commits.txt
        fi

        while IFS= read -r commit; do
            [[ -n "$commit" ]] && commits+=("$commit")
        done < /tmp/pr_commits.txt

    # Check if input is a commit range or single commit
    elif [[ "$input" =~ \.\. ]] || git rev-parse --verify "$input" &>/dev/null; then
        echo "Detected commit range/ID: $input" >&2
        echo "**Review Type:** Commit Range/ID: \`$input\`" >> "$COMMIT_LIST_FILE"
        echo "" >> "$COMMIT_LIST_FILE"

        if [[ "$input" =~ \.\. ]]; then
            # Commit range
            git rev-list "$input" --reverse > /tmp/commit_range.txt
        else
            # Single commit
            echo "$input" > /tmp/commit_range.txt
        fi

        while IFS= read -r commit; do
            [[ -n "$commit" ]] && commits+=("$commit")
        done < /tmp/commit_range.txt

    else
        echo "Detected natural language description: $input" >&2
        echo "**Review Type:** Description: \"$input\"" >> "$COMMIT_LIST_FILE"
        echo "" >> "$COMMIT_LIST_FILE"

        # For natural language, get commits from last week
        git log --since="1 week ago" --pretty=format:"%H" > /tmp/recent_commits.txt

        while IFS= read -r commit; do
            [[ -n "$commit" ]] && commits+=("$commit")
        done < /tmp/recent_commits.txt
    fi

    # Add commits to checklist
    echo "## Commits to Review" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    for commit in "${commits[@]}"; do
        local short_hash=$(git rev-parse --short "$commit")
        local subject=$(git log -1 --pretty=format:"%s" "$commit")
        local author=$(git log -1 --pretty=format:"%an" "$commit")
        local date=$(git log -1 --pretty=format:"%ad" --date=short "$commit")

        echo "- [ ] [\`$short_hash\`] $subject (*$author*, $date)" >> "$COMMIT_LIST_FILE"
    done

    # Add review criteria
    echo "" >> "$COMMIT_LIST_FILE"
    echo "## Review Criteria" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "For each commit, analyze:" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "1. **Mock Analysis**: New mocks and alternatives" >> "$COMMIT_LIST_FILE"
    echo "2. **Test Coverage**: Quality and completeness of tests" >> "$COMMIT_LIST_FILE"
    echo "3. **Error Handling**: Unnecessary try/catch blocks and over-engineering" >> "$COMMIT_LIST_FILE"
    echo "4. **Interface Changes**: New/modified public interfaces" >> "$COMMIT_LIST_FILE"
    echo "5. **Timer Analysis**: Artificial delays and timer usage patterns" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "---" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    printf '%s\n' "${commits[@]}"
}

# Function to review a single commit
review_commit() {
    local commit="$1"
    local short_hash=$(git rev-parse --short "$commit")
    local review_file="$REVIEW_DIR/review-$short_hash.md"

    echo "Reviewing commit $short_hash..." >&2

    # Generate review content
    cat > "$review_file" << EOF
# Code Review: $short_hash

## Commit Information

**Hash:** \`$commit\`
**Subject:** $(git log -1 --pretty=format:"%s" "$commit")
**Author:** $(git log -1 --pretty=format:"%an <%ae>" "$commit")
**Date:** $(git log -1 --pretty=format:"%ad" "$commit")

## Changes Summary

\`\`\`diff
$(git show --stat "$commit")
\`\`\`

## Review Analysis

### 1. Mock Analysis

$(git show "$commit" | grep -i "mock\|stub\|spy" | head -10 || echo "No obvious mocks detected in this commit.")

**New Mocks Found:**
- [ ] TODO: List any new mock implementations
- [ ] TODO: Evaluate if mocks can be replaced with real implementations
- [ ] TODO: Check if mocks are properly cleaned up

### 2. Test Coverage

\`\`\`bash
# Test files modified in this commit
$(git show --name-only "$commit" | grep -E '\.(test|spec)\.' || echo "No test files modified")
\`\`\`

**Test Quality Assessment:**
- [ ] TODO: Are new features properly tested?
- [ ] TODO: Are edge cases covered?
- [ ] TODO: Are tests maintainable and readable?

### 3. Error Handling Review

**Try/Catch Blocks:**
\`\`\`typescript
$(git show "$commit" | grep -A 5 -B 2 "try\s*{" || echo "No try/catch blocks found")
\`\`\`

**Assessment:**
- [ ] TODO: Are try/catch blocks necessary?
- [ ] TODO: Can we implement fail-fast instead?
- [ ] TODO: Is error handling over-engineered?

### 4. Interface Changes

**New/Modified Interfaces:**
\`\`\`typescript
$(git show "$commit" | grep -E "(interface|type|class|function)" | head -10 || echo "No obvious interface changes")
\`\`\`

**Key Changes:**
- [ ] TODO: Document new public interfaces
- [ ] TODO: Check for breaking changes
- [ ] TODO: Validate API design decisions

### 5. Timer and Delay Analysis

**Timer/Delay Usage:**
\`\`\`typescript
$(git show "$commit" | grep -E "(setTimeout|setInterval|sleep|delay|wait|advanceTimers|useFakeTimers|jest\.advanceTimersByTime|vi\.advanceTimersByTime)" | head -10 || echo "No timer/delay usage detected")
\`\`\`

**Assessment:**
- [ ] TODO: Are artificial delays necessary in production code?
- [ ] TODO: Check for advanceTimers or fakeTimers in tests
- [ ] TODO: Flag any timeout increases to pass tests
- [ ] TODO: Suggest deterministic alternatives to time-based solutions

## Files Changed

$(git show --name-only "$commit" | sed 's/^/- /')

## Recommendations

- [ ] TODO: Add specific recommendations based on review
- [ ] TODO: Highlight any concerns or improvements needed
- [ ] TODO: Note positive aspects of the implementation

---

*Review completed on: $(date)*
EOF

    echo "review-$short_hash.md"
}

# Function to update commit list with review links
update_commit_list_with_links() {
    local -a commits=("$@")

    # Backup original
    cp "$COMMIT_LIST_FILE" "$COMMIT_LIST_FILE.backup"

    # Update checkboxes to links
    for commit in "${commits[@]}"; do
        local short_hash=$(git rev-parse --short "$commit")
        local review_file="review-$short_hash.md"

        # Replace checkbox with link
        sed -i "s/- \[ \] \[\`$short_hash\`\]/- [x] [\`$short_hash\`]($review_file)/" "$COMMIT_LIST_FILE"
    done
}

# Function to generate summary
generate_summary() {
    local -a commits=("$@")

    echo "" >> "$COMMIT_LIST_FILE"
    echo "## Review Summary" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "*Generated on: $(date)*" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    # Count reviews
    local total_commits=${#commits[@]}
    echo "**Total Commits Reviewed:** $total_commits" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    # Add summary sections
    echo "### Key Findings" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Summarize major concerns across all commits" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Highlight patterns in issues found" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Note overall code quality trends" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    echo "### Mock Usage Summary" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: List all new mocks across commits" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Suggest alternatives where applicable" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    echo "### Test Coverage Summary" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Overall test coverage assessment" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Areas needing more tests" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    echo "### Architecture & Design" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Assess adherence to project principles (YAGNI, fail-fast)" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Note any over-engineering concerns" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Highlight good design decisions" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"

    echo "### Action Items" >> "$COMMIT_LIST_FILE"
    echo "" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Priority fixes needed" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Suggested improvements" >> "$COMMIT_LIST_FILE"
    echo "- [ ] TODO: Follow-up tasks" >> "$COMMIT_LIST_FILE"
}

# Main execution
main() {
    local input="$1"

    if [[ -z "$input" ]]; then
        echo "Usage: $0 <pr-id|commit-id|description>"
        echo "Examples:"
        echo "  $0 123                    # Review PR #123"
        echo "  $0 abc123..def456         # Review commit range"
        echo "  $0 abc123                 # Review single commit"
        echo "  $0 'auth changes'         # Review by description"
        exit 1
    fi

    echo "Starting code review for: $input"

    # Generate commit list
    echo "Generating commit list..."
    readarray -t commits < <(generate_commit_list "$input")

    echo "Found ${#commits[@]} commits to review"

    # Review each commit
    echo "Starting individual commit reviews..."
    for commit in "${commits[@]}"; do
        review_commit "$commit"
    done

    # Update commit list with links
    echo "Updating commit list with review links..."
    update_commit_list_with_links "${commits[@]}"

    # Generate summary
    echo "Generating review summary..."
    generate_summary "${commits[@]}"

    echo "Code review complete!"
    echo "Review files generated in: $REVIEW_DIR"
    echo "Master checklist: $COMMIT_LIST_FILE"
}

# Run main function with all arguments
main "$@"
