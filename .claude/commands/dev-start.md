---
command: dev-start
description: Start the development server in background mode
---

Start the development server using the dev-server skill with context fork isolation.

```typescript
await Skill({
  skill: "dev-server",
  args: "start"
});
```

**Usage**: `/dev-start`

**What it does**: Starts the Turbo development server in background with stream UI mode. Automatically stops any running dev server and generates SSL certificates if needed.
