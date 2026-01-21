---
command: dev-tunnel
description: Start dev server with Cloudflare tunnel and authenticate CLI
---

Start dev server with Cloudflare tunnel using the dev-server skill with context fork isolation.

```typescript
await Skill({
  skill: "dev-server",
  args: "tunnel"
});
```

**Usage**: `/dev-tunnel`

**What it does**: Installs dependencies, builds project, starts dev server with Cloudflare tunnel for webhook testing, and authenticates CLI. Exposes localhost:3000 via `*.trycloudflare.com` URL.