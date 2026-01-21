---
command: issue-create
description: Create a GitHub issue by intelligently summarizing the current conversation context
---

# Create Issue from Conversation

Create a GitHub issue from the current conversation using the issue-manager skill with context fork isolation.

```typescript
await Skill({
  skill: "issue-manager",
  args: "create"
});
```

**Usage**: `/issue-create`

**What it does**: Analyzes the current conversation and creates a well-structured GitHub issue that captures key points, decisions, and context. Automatically determines issue type (feature, bug, task, etc.) and creates appropriate labels.
