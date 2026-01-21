---
command: issue-compact
description: Compact GitHub Issue
---

# Compact GitHub Issue

Consolidate all issue discussion into a single organized body using the issue-manager skill with context fork isolation.

```typescript
await Skill({
  skill: "issue-manager",
  args: "compact"
});
```

**Usage**: `/issue-compact`

**What it does**: Retrieves the issue from conversation context, consolidates all discussion (body, comments, conversation context) into a well-organized issue body for handoff, then removes all comments. Preserves decisions, requirements, technical details, and next steps.
