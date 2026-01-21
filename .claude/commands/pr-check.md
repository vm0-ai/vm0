---
description: Automated PR pipeline monitoring and issue fixing (no auto-merge)
---

Monitor PR pipeline using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "monitor"
});
```

**Usage**: `/pr-check [pr-id]`

**What it does**: Monitors CI pipeline status, attempts automatic fixes for lint/format issues, reports test and type check failures. Does not auto-merge.
