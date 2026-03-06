---
command: dev-start-github
description: Start the development server with a fixed GitHub tunnel URL
---

```typescript
await Skill({
  skill: "dev-server",
  args: "start --tunnel-hostname=tunnel-github-dev.vm7.ai"
});
```
