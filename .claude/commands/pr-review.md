---
command: pr-review
description: Review a pull request and post findings as a PR comment
---

Review a pull request using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "review"
});
```

**Usage**: `/pr-review [pr-id]`

**What it does**: Performs code review analysis and posts findings as a GitHub PR comment.
