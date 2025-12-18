---
command: pr-review
description: Review a pull request with detailed analysis of changes
---

Reviews a pull request by fetching PR information and delegating the code review to `/code-review`.

Usage: `/pr-review [PR_NUMBER]`
- If PR_NUMBER is provided, reviews that specific PR
- If no argument is given, reviews the PR associated with the current branch

## Workflow

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
```

After fetching PR information, delegate to `/code-review` for the actual code review:

**Execute `/code-review $PR_NUMBER`** to perform the detailed code review.

The `/code-review` command will:
1. Parse the PR and get the commit list
2. Create output directory `codereviews/yyyymmdd`
3. Generate `commit-list.md` with checkboxes for each commit
4. Review each commit against the project's bad code smell criteria
5. Generate individual review files per commit
6. Update commit list with links to review files
7. Generate overall review summary
