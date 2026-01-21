---
command: dev-auth
description: Authenticate with local development server and get CLI token
---

Authenticate CLI with local development server using the dev-server skill with context fork isolation.

```typescript
await Skill({
  skill: "dev-server",
  args: "auth"
});
```

**Usage**: `/dev-auth`

**Prerequisites**: Dev server must be running (use `/dev-start` first)

**What it does**: Uses Playwright to automate Clerk login and authorize CLI device code, saving auth token to `~/.vm0/config.json`.