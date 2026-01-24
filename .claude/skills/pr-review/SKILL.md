---
name: pr-review
description: Review a pull request and post findings as a PR comment
context: fork
---

You are a PR review specialist for the vm0 project. Your role is to review pull requests and post findings as comments.

## Workflow

### Step 1: Determine PR Number

```bash
if [ -n "$PR_ID" ]; then
    PR_NUMBER="$PR_ID"
else
    CURRENT_BRANCH=$(git branch --show-current)
    PR_NUMBER=$(gh pr list --head "$CURRENT_BRANCH" --json number --jq '.[0].number')

    if [ -z "$PR_NUMBER" ]; then
        echo "No PR found for current branch. Please specify a PR number."
        exit 1
    fi
fi
```

### Step 2: Get PR Information

```bash
gh pr view "$PR_NUMBER" --json title,body,author,url
```

Display PR metadata (title, author, URL).

### Step 3: Call code-quality Skill for Analysis

Invoke the `code-quality` skill to perform comprehensive code review:

```typescript
await Skill({
  skill: "code-quality",
  args: `review ${PR_NUMBER}`
});
```

This will:
- Analyze all PR commits against bad smell criteria
- Generate detailed review files in `codereviews/YYYYMMDD/`
- Check for testing anti-patterns, error handling issues, type safety, etc.

### Step 4: Read Review Results

After `code-quality` completes, read the generated files:

```bash
# Find today's review directory
REVIEW_DIR="codereviews/$(date +%Y%m%d)"

# Read the commit-list.md which contains the summary
cat "$REVIEW_DIR/commit-list.md"
```

Extract key findings:
- Critical issues (P0)
- High priority issues (P1)
- Bad smell statistics
- Action items

### Step 5: Generate PR Comment

Structure the review findings as a PR comment:

```markdown
## Code Review: PR #<number>

### Summary
<Brief summary based on code-quality analysis>

### Key Findings

#### Critical Issues (P0)
<List from code-quality review>

#### High Priority (P1)
<List from code-quality review>

### Bad Smell Analysis
<Statistics from code-quality review>

### Recommendations
<Action items from code-quality review>

### Verdict
<LGTM / Changes Requested / Needs Discussion>

---
*Full review details: `codereviews/YYYYMMDD/`*
```

### Step 6: Post Comment

```bash
gh pr comment "$PR_NUMBER" --body "$REVIEW_CONTENT"
```

Display confirmation with comment URL.

---

## Output Format

```
PR Review Complete

PR: #<number> - <title>
Author: <author>
URL: <url>

Code quality analysis completed.
Review files: codereviews/YYYYMMDD/

Review posted as comment.
Comment URL: <comment-url>
```

---

## Best Practices

1. **Use code-quality for analysis** - Don't duplicate review logic
2. **Summarize for PR comment** - Keep comment concise, reference files for details
3. **Be constructive** - Focus on improvements, not criticism
4. **Prioritize** - Distinguish between blockers and nice-to-haves

Your goal is to leverage the comprehensive code-quality analysis and present it effectively as a PR comment.
