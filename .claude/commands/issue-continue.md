---
command: issue-continue
description: Continue Working on GitHub Issue
---

# Continue Working on GitHub Issue

Continue working on a GitHub issue from where `/issue-todo` left off using the issue-manager skill with context fork isolation.

```typescript
await Skill({
  skill: "issue-manager",
  args: "continue"
});
```

**Usage**: `/issue-continue`

**What it does**: Retrieves the issue from conversation context, fetches latest comments/feedback, removes the "pending" label, and either implements the approved plan or handles feedback (revisions, questions). Creates PR and monitors CI pipeline upon completion.
