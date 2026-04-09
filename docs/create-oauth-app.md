## Create OAuth App

When integrating a new OAuth provider, create **two separate apps** per provider to achieve hard isolation of client ID and secret between environments.

### Naming & Slug

| Environment | App Name (preferred) | Fallback (if name too short) |
|-------------|----------------------|------------------------------|
| Production  | VM0                  | VM0 AI                       |
| Development | VM0 TEST             | VM0 AI TEST                  |

- Prefer **VM0** over VM0 AI whenever the platform allows it.
- The URL slug should match the app name: prefer `vm0`, fall back to `vm0-ai`.
- Some platforms enforce a minimum name length. Use the fallback names in that case.

### Common Fields

| Field       | Value                          |
|-------------|--------------------------------|
| Developer / Company | Max & Zoe, Inc.        |
| Contact Email       | contact@vm0.ai         |
| Support Email       | support@vm0.ai         |
| Website             | https://www.vm0.ai     |
| Documentation URL   | https://www.vm0.ai     |

### Product Description

Use the following when the OAuth provider asks for an app description:

> VM0 is a cloud platform for building and deploying AI agents using natural language. Developers describe agent behavior conversationally, and agents run 24/7 in managed cloud sandboxes with full observability, session persistence, and 50+ pre-built integrations.

### Logo

Upload the VM0 logo manually when the platform requires one.

### Callback URIs

| Environment | Callback URI |
|-------------|-------------|
| Production  | `https://www.vm0.ai/api/connectors/{provider}/callback` |
| Development | `https://www.vm7.ai:8443/api/connectors/{provider}/callback` |

Replace `{provider}` with the lowercase provider name. Examples:

| Provider     | Production Callback | Development Callback |
|-------------|--------------------|--------------------|
| Deel         | `https://www.vm0.ai/api/connectors/deel/callback` | `https://www.vm7.ai:8443/api/connectors/deel/callback` |
| Gmail        | `https://www.vm0.ai/api/connectors/gmail/callback` | `https://www.vm7.ai:8443/api/connectors/gmail/callback` |
| Google Sheet | `https://www.vm0.ai/api/connectors/google-sheet/callback` | `https://www.vm7.ai:8443/api/connectors/google-sheet/callback` |
| Strava       | `https://www.vm0.ai/api/connectors/strava/callback` | `https://www.vm7.ai:8443/api/connectors/strava/callback` |

### Webhook URIs

If the OAuth provider requires a webhook URL:

| Environment | Webhook URI |
|-------------|-------------|
| Production  | `https://www.vm0.ai/api/webhooks/{provider}` |
| Development | `https://tunnel-{provider}-dev.vm7.ai/api/webhooks/{provider}` |

Examples:

| Provider | Production Webhook | Development Webhook |
|----------|-------------------|-------------------|
| Vercel   | `https://www.vm0.ai/api/webhooks/vercel` | `https://tunnel-vercel-dev.vm7.ai/api/webhooks/vercel` |
| Neon     | `https://www.vm0.ai/api/webhooks/neon` | `https://tunnel-neon-dev.vm7.ai/api/webhooks/neon` |

### Why Two Apps?

- **Hard isolation** — Production and development credentials never mix. A leaked dev secret cannot compromise production.
- **Safe testing** — Development callbacks point to `vm7.ai:8443`, so OAuth flows can be tested locally without affecting production users.
- **Independent rotation** — Credentials can be rotated per environment without cross-impact.
