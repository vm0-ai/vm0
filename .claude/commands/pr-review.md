---
command: pr-review
description: Review a pull request with detailed analysis of changes
---

Review a pull request using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "review"
});
```

**Usage**: `/pr-review [pr-id]`

**What it does**: Fetches PR information and performs detailed code review analysis of all commits.
