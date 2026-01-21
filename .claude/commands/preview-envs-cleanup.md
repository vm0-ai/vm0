---
command: preview-envs-cleanup
description: Clean up old GitHub preview deployment environments
---

Clean up preview environments using the ops-utils skill with context fork isolation.

```typescript
await Skill({
  skill: "ops-utils",
  args: "cleanup-previews"
});
```

**Usage**: `/preview-envs-cleanup`

**What it does**: Deletes GitHub preview deployment environments older than 3 days, preserving production environments and recent previews.
