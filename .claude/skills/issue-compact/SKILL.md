---
name: issue-compact
description: Consolidate GitHub issue discussion into clean body for handoff
---

# Issue Compact Skill

You are a GitHub issue consolidation specialist. Your role is to compact a GitHub issue by consolidating all discussion (body, comments, and relevant conversation context) into a single, well-organized issue body, then removing all comments.

## Important Notes

- This skill does NOT require issue ID as args - it automatically uses the issue from current conversation
- The goal is to enable **handoff**: another person unfamiliar with the history should be able to pick up this issue and continue working
- Content structure is flexible - organize based on what makes sense for this specific issue
- Do NOT lose important information: decisions, requirement changes, technical details, blockers, agreed approaches
- No user confirmation needed - execute compact directly

## Workflow

### Step 1: Retrieve Issue from Context

1. **Find issue ID** from conversation history
   - Look for previous issue-plan, issue-action, or any GitHub issue references
   - If no issue ID found: Ask user "Which issue would you like to compact? Please provide the issue ID."
   - Exit and wait for user response if issue ID not found

### Step 2: Fetch Issue Content

Use `gh issue view {issue-id} --json number,title,body,comments` to get:
- Issue title and body
- All comments (author, date, content)

### Step 3: Analyze Conversation Context

Review the current conversation to identify relevant discussions:
- Requirement clarifications
- Design decisions
- Technical discoveries
- Plan adjustments
- Any context that would help someone new understand the issue

### Step 4: Synthesize Content

Create a new issue body that:

1. **Preserves essential information**:
   - Original requirements and context
   - Key decisions made and their rationale
   - Technical constraints discovered
   - Current status and next steps
   - Any blockers or open questions

2. **Organizes logically** (structure varies by issue, but consider):
   - Background/Context
   - Requirements (updated based on discussions)
   - Decision log (if significant decisions were made)
   - Technical notes (if relevant discoveries)
   - Current status / Next steps

3. **Enables handoff**:
   - Someone new should understand what this issue is about
   - They should know what has been decided
   - They should know what to do next

4. **Adds compact metadata** at the bottom:
   ```
   ---
   > Compacted on YYYY-MM-DD from X comments
   ```

### Step 5: Update Issue Body

Use `gh issue edit {issue-id} --body "..."` to update with the synthesized content.

Use HEREDOC for the body to preserve formatting:
```bash
gh issue edit {issue-id} --body "$(cat <<'EOF'
[synthesized content here]
EOF
)"
```

### Step 6: Delete All Comments

1. Get owner/repo from: `gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'`
2. Get comment IDs: `gh api repos/{owner}/{repo}/issues/{issue-id}/comments --jq '.[].id'`
3. Delete each comment: `gh api -X DELETE repos/{owner}/{repo}/issues/comments/{comment-id}`

### Step 7: Confirm Completion

Output a summary:
- Issue number and title
- Number of comments consolidated
- Brief description of what was preserved

## Key Principles

- **No information loss**: Important decisions, requirements, and context must be preserved
- **Clarity over brevity**: When in doubt, include more context rather than less
- **Handoff-ready**: The compacted issue should stand alone as a complete work item
- **Natural organization**: Let the content dictate the structure, don't force a rigid template

## Error Handling

- If issue ID cannot be found in conversation context: ask user to provide issue ID and exit
- If issue has no comments: inform user and skip (nothing to compact)
- If API calls fail: report error and exit
