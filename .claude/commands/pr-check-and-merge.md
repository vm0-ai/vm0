---
description: Automated PR pipeline monitoring, issue fixing, and merging workflow
---

Monitor, fix, and merge PR using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "check-and-merge"
});
```

**Usage**: `/pr-check-and-merge [pr-id]`

**What it does**: Monitors CI pipeline, attempts automatic fixes for lint/format issues, and merges PR after all checks pass. Combines monitoring + auto-fixing + merging in one workflow.
