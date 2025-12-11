---
command: pr-review-and-comment
description: Review a pull request and post the review as a PR comment
---

Reviews a pull request by analyzing its diff, understanding the changes, and posting the review as a comment on the PR.

Usage: `/pr-review-and-comment [PR_NUMBER]`
- If PR_NUMBER is provided, reviews that specific PR
- If no argument is given, reviews the PR associated with the current branch

The review includes:
1. Summary of what the PR accomplishes
2. List of modified files
3. Key code changes, especially:
   - Data structure modifications
   - API changes
   - Critical logic updates
4. Code review feedback and suggestions

```bash
# Get PR number from argument or current branch
if [ -n "$1" ]; then
    PR_NUMBER="$1"
else
    # Get current branch name
    CURRENT_BRANCH=$(git branch --show-current)

    # Find PR associated with current branch
    PR_NUMBER=$(gh pr list --head "$CURRENT_BRANCH" --json number --jq '.[0].number')

    if [ -z "$PR_NUMBER" ]; then
        echo "No PR found for current branch '$CURRENT_BRANCH'. Please specify a PR number."
        exit 1
    fi
fi

echo "Reviewing PR #$PR_NUMBER..."
echo

# Get PR information
gh pr view "$PR_NUMBER" --json title,body,author,url | jq -r '"Title: \(.title)\nAuthor: \(.author.login)\nURL: \(.url)\n"'

# Get the diff
echo "Fetching PR diff..."
gh pr diff "$PR_NUMBER"
```

After fetching the diff, analyze:

1. **What this PR does:**
   - Main purpose and goals
   - Problems it solves
   - Features it adds/modifies

2. **Modified files:**
   - List all changed files with statistics
   - Group by type (source, config, tests, docs)

3. **Key changes:**
   - Data structures (interfaces, types, schemas)
   - API endpoints or function signatures
   - Database schema changes
   - Configuration changes
   - Breaking changes

4. **Code review:**
   - Code quality and style consistency
   - Potential bugs or edge cases
   - Performance considerations
   - Security implications
   - Test coverage
   - Documentation updates needed

5. **Suggestions:**
   - Improvements or optimizations
   - Missing error handling
   - Alternative approaches
   - Additional test cases needed

## Post Review as PR Comment

After completing the analysis, format the review as a markdown comment and post it to the PR using:

```bash
gh pr comment "$PR_NUMBER" --body "REVIEW_CONTENT_HERE"
```

The comment should be formatted with clear sections and use markdown formatting for readability. Include a header indicating this is an automated review from Claude Code.
