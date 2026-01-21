---
command: dev-stop
description: Stop the background development server
---

Stop the development server using the dev-server skill with context fork isolation.

```typescript
await Skill({
  skill: "dev-server",
  args: "stop"
});
```

**Usage**: `/dev-stop`

**What it does**: Gracefully stops the background development server and verifies the process has terminated.