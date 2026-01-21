---
command: pr-list
description: List open pull requests for the current repository
---

List open pull requests using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "list"
});
```