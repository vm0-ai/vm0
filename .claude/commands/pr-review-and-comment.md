---
command: pr-review-and-comment
description: Review a pull request and post the review as a PR comment
---

Reviews a pull request by fetching PR information, delegating the code review to `/code-review`, and posting the review as a comment on the PR.

Usage: `/pr-review-and-comment [PR_NUMBER]`
- If PR_NUMBER is provided, reviews that specific PR
- If no argument is given, reviews the PR associated with the current branch

## Workflow

### Step 1: Get PR Information

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

### Step 2: Execute Code Review

**Execute `/code-review $PR_NUMBER`** to perform the detailed code review.

The `/code-review` command will:
1. Parse the PR and get the commit list
2. Create output directory `codereviews/yyyymmdd`
3. Generate `commit-list.md` with checkboxes for each commit
4. Review each commit against the project's bad code smell criteria
5. Generate individual review files per commit
6. Update commit list with links to review files
7. Generate overall review summary

### Step 3: Post Review as PR Comment

After the code review is complete, compile the review summary and post it to the PR:

```bash
gh pr comment "$PR_NUMBER" --body "REVIEW_CONTENT_HERE"
```

The comment should:
- Include a header indicating this is an automated review from Claude Code
- Summarize the key findings from the code review
- List any issues or suggestions found
- Use markdown formatting for readability
- Reference the detailed review files in `codereviews/yyyymmdd/` for full details
