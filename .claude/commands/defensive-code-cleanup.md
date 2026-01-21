---
command: defensive-code-cleanup
description: Clean Defensive Try-Catch Blocks
---

Remove defensive try-catch blocks using the code-quality skill with context fork isolation.

```typescript
await Skill({
  skill: "code-quality",
  args: "cleanup"
});
```

**Usage**: `/defensive-code-cleanup`

**What it does**: Finds and removes defensive try-catch blocks that violate the "Avoid Defensive Programming" principle, creates PR with changes, and monitors CI pipeline.
