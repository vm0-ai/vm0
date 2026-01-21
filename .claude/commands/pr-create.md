---
command: pr-create
description: Git commit and PR workflow
---

Create PR with commits using the pull-request skill with context fork isolation.

```typescript
await Skill({
  skill: "pull-request",
  args: "create"
});
```

**Usage**: `/pr-create`

**What it does**: Creates feature branch (if on main), runs pre-commit checks (format, lint, type, test), commits changes with conventional commit message, pushes to GitHub, and creates pull request.
