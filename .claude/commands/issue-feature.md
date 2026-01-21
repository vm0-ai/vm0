---
command: issue-feature
description: Create a feature request issue focused on user requirements and acceptance criteria
---

# Create Feature Request

Create a feature request issue using the issue-manager skill with context fork isolation.

```typescript
await Skill({
  skill: "issue-manager",
  args: "feature"
});
```

**Usage**: `/issue-feature`

**What it does**: Creates a feature request issue focused on user requirements and acceptance criteria. Captures what users need (not implementation details), defines clear success criteria, and describes user value and business goals.
