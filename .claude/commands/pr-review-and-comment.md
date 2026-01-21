---
command: pr-review-and-comment
description: Review a pull request and post the review as a PR comment
---

Review PR and post comment using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "review-and-comment"
});
```

**Usage**: `/pr-review-and-comment [pr-id]`

**What it does**: Performs code review analysis and posts findings as a GitHub PR comment.
