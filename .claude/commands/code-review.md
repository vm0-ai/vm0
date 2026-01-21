---
command: code-review
description: Comprehensive code review tool
---

Perform comprehensive code review using the code-quality skill with context fork isolation.

```typescript
await Skill({
  skill: "code-quality",
  args: "review"
});
```

**Usage**: `/code-review [pr-id|commit-id|description]`

**What it does**: Analyzes commits against project's bad smell criteria, generates detailed review files in `codereviews/YYYYMMDD/` directory with comprehensive summary.
