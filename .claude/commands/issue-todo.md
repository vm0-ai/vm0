---
command: issue-todo
description: Start Working on GitHub Issue
---

# Start Working on GitHub Issue

Start working on a GitHub issue with the deep-dive workflow using the issue-manager skill with context fork isolation.

```typescript
await Skill({
  skill: "issue-manager",
  args: "todo"
});
```

**Usage**: `/issue-todo <issue-id>`

**What it does**: Fetches the issue, executes the complete deep-dive workflow (research, innovate, plan phases), posts all findings as comments to the issue, and waits for approval with a "pending" label. Auto-continues through all phases without user confirmation.
