---
command: dev-logs
description: View development server logs with optional filtering
---

View development server logs using the dev-server skill with context fork isolation.

```typescript
await Skill({
  skill: "dev-server",
  args: "logs"
});
```

**Usage**:
- `/dev-logs` - Show all new logs
- `/dev-logs [pattern]` - Filter logs with regex pattern

**Examples**: `/dev-logs error`, `/dev-logs "compiled|ready"`