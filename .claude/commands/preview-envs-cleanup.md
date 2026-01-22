---
command: preview-envs-cleanup
description: Clean up old GitHub preview deployment environments
---

```typescript
await Skill({
  skill: "ops-utils",
  args: "cleanup-previews"
});
```
