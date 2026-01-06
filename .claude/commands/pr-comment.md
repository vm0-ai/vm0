---
command: pr-comment
description: Summarize conversation discussion and post as PR comment for follow-up
---

# Post Conversation Summary as PR Comment

Analyze the current conversation and post a structured summary as a comment on a pull request for the PR owner or team to follow up.

## Purpose

Transform discussion context into actionable PR comments. Useful for:
- Technical decisions that need to be tracked
- Follow-up tasks identified during review
- Design discussions that affect implementation
- Action items for PR owners

## Usage

```
/pr-comment [instructions]
```

- `instructions` (optional): Specific guidance on what to summarize or how to format
- PR number is automatically detected from conversation context

## Workflow

### 1. Detect PR Number from Context

Automatically identify the PR being discussed:

1. **From conversation context** (preferred): Look for PR numbers mentioned in the discussion (e.g., "PR #935", "reviewing PR 123", discussion about a specific PR)
2. **From current branch**: If no PR mentioned, check current git branch
   ```bash
   CURRENT_BRANCH=$(git branch --show-current)
   PR_NUMBER=$(gh pr list --head "$CURRENT_BRANCH" --json number --jq '.[0].number')
   ```
3. **Ask user**: If PR cannot be determined, use AskUserQuestion to clarify

```bash
# Validate PR exists
gh pr view "$PR_NUMBER" --json number,title,url
```

### 2. Analyze Conversation Context

Review the recent conversation to identify:
- Key discussion points and decisions
- Technical findings or analysis results
- Action items or follow-up tasks
- Recommendations or suggestions
- Open questions requiring input

**Focus on:**
- Information relevant to the PR
- Actionable items for the PR owner
- Technical details that affect implementation
- Decisions that should be documented

### 3. Clarify with User (if needed)

If the user provided instructions, follow them directly.

If no instructions or context is unclear, use AskUserQuestion to:
- Confirm what aspects of the discussion to include
- Verify the intended audience and tone
- Clarify any ambiguous points

### 4. Structure the Comment

Organize the summary based on content type:

**For technical memos:**
```markdown
## Technical Memo: [Topic]

[Summary of discussion]

### Key Points
- Point 1
- Point 2

### Action Items
- [ ] Task 1
- [ ] Task 2

### Recommendations
[If applicable]
```

**For follow-up tasks:**
```markdown
## Follow-up Required: [Topic]

[Context from discussion]

### Tasks
- [ ] Task 1
- [ ] Task 2

### Notes
[Additional context]
```

**For decisions/conclusions:**
```markdown
## Decision Record: [Topic]

### Context
[What was discussed]

### Decision
[What was decided]

### Rationale
[Why this decision]

### Next Steps
- [ ] Step 1
- [ ] Step 2
```

**Guidelines:**
- Keep it concise and actionable
- Use tables for comparisons or structured data
- Include code references when relevant
- Use checkboxes for trackable tasks
- Write in English (project standard)

### 5. Post Comment

```bash
gh pr comment "$PR_NUMBER" --body "COMMENT_CONTENT"
```

### 6. Return Result

Show the comment URL. Keep response simple.

## Examples

**Example 1: Auto-detect PR, summarize discussion**
```
/pr-comment summarize our script cleanup discussion
```
Detects PR from context, posts structured summary.

**Example 2: List action items**
```
/pr-comment list the action items we discussed
```
Posts a checklist of follow-up tasks.

**Example 3: Specific format request**
```
/pr-comment create a decision record for the architecture choice
```
Posts a formal decision record.

**Example 4: No instructions**
```
/pr-comment
```
Analyzes context, summarizes key discussion points, asks if unclear.

## Notes

- Always verify the PR exists before posting
- Use markdown formatting for readability
- Keep comments focused and actionable
- Reference relevant files or code when helpful
