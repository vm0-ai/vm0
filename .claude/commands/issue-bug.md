---
command: issue-bug
description: Create a bug report with reproduction steps, environment details, and error information
---

# Create Bug Report

Create a comprehensive bug report using the issue-manager skill with context fork isolation.

```typescript
await Skill({
  skill: "issue-manager",
  args: "bug"
});
```

**Usage**: `/issue-bug`

**What it does**: Creates a bug report issue with reproduction steps, expected vs actual behavior, environment details, error messages, and impact assessment. Gathers missing details through clarifying questions.
