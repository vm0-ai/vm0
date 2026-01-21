---
command: pr-comment
description: Summarize conversation discussion and post as PR comment for follow-up
---

Summarize conversation and post PR comment using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "comment"
});
```

**Usage**: `/pr-comment [pr-id]`

**What it does**: Analyzes conversation context and posts structured summary as PR comment for follow-up and tracking.
