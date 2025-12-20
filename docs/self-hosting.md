# Self-Hosting VM0 (Community Edition)

VM0 Community Edition allows you to self-host the VM0 platform without requiring Clerk authentication. Perfect for personal use, development, or private deployments.

## One-Click Deployment

Deploy VM0 to Vercel with a single click:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvm0-ai%2Fvm0&project-name=vm0-community&repository-name=vm0-community&root-directory=turbo%2Fapps%2Fweb&env=VM0_EDITION,E2B_API_KEY,R2_ACCOUNT_ID,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY,R2_USER_STORAGES_BUCKET_NAME,VM0_COMMUNITY_AUTH_TOKEN&envDefaults=%7B%22VM0_EDITION%22%3A%22community%22%7D&envDescription=VM0_EDITION%3A%20pre-filled.%20E2B%20and%20R2%20keys%20required%20for%20full%20functionality.&envLink=https%3A%2F%2Fgithub.com%2Fvm0-ai%2Fvm0%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md&integration-ids=oac_3sK3gnG06emjIEVL09jjntDD&skippable-integrations=1)

The deployment will:
1. Clone the VM0 repository to your GitHub account
2. Set up a Neon PostgreSQL database (via Vercel integration)
3. Deploy the web application to Vercel

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (auto-provisioned by Neon integration) |
| `VM0_EDITION` | Must be set to `community` for Community Edition. Pre-filled by deploy button. |

### Optional

| Variable | Description |
|----------|-------------|
| `VM0_COMMUNITY_AUTH_TOKEN` | API protection token. When set, CLI requests must include this token. |
| `E2B_API_KEY` | E2B sandbox API key for running agents |
| `R2_ACCOUNT_ID` | Cloudflare R2 account ID for storage |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_USER_STORAGES_BUCKET_NAME` | R2 bucket name |
| `SECRETS_ENCRYPTION_KEY` | 64-character hex string for encrypting secrets |

## CLI Configuration

### Without API Protection (Open Access)

If `VM0_COMMUNITY_AUTH_TOKEN` is not set, the API is open:

```bash
# Point CLI to your self-hosted instance
export VM0_API_URL=https://your-deployment.vercel.app

# Use VM0 commands directly
vm0 auth status
vm0 run my-agent "hello world"
```

### With API Protection

If you set `VM0_COMMUNITY_AUTH_TOKEN` on your server:

```bash
# Server-side (Vercel environment variables)
VM0_COMMUNITY_AUTH_TOKEN=your-secret-token-here

# Client-side (CLI)
export VM0_API_URL=https://your-deployment.vercel.app
export VM0_TOKEN=your-secret-token-here

vm0 run my-agent "hello world"
```

## Edition Comparison

| Feature | Community Edition | Cloud Edition |
|---------|-------------------|---------------|
| Authentication | Fixed userId + optional token | Clerk multi-user |
| CLI Authentication | `VM0_TOKEN` env var | Device Flow |
| Data Isolation | Single user (`community_edition`) | Multi-user by Clerk userId |
| Login UI | None (redirects to home) | Clerk components |
| User Management | None | Clerk Dashboard |
| Clerk Required | No | Yes |

## Database Setup

The Vercel deploy button includes Neon PostgreSQL integration which automatically:
- Creates a new Neon project
- Provisions a PostgreSQL database
- Sets the `DATABASE_URL` environment variable

If you prefer a different database provider, you can:
1. Skip the Neon integration during deployment
2. Manually set `DATABASE_URL` to your PostgreSQL connection string
3. Run migrations: `pnpm db:migrate`

## Storage Setup (Optional)

For artifact and volume storage, you'll need Cloudflare R2:

1. Create a Cloudflare account and enable R2
2. Create a bucket for user storages
3. Generate R2 API credentials
4. Set the following environment variables:
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_USER_STORAGES_BUCKET_NAME`

## Sandbox Setup (Optional)

To run agents in sandboxes, you'll need an E2B API key:

1. Sign up at [e2b.dev](https://e2b.dev)
2. Get your API key from the dashboard
3. Set `E2B_API_KEY` in your environment variables

## Troubleshooting

### Build Fails

The VM0 web app is part of a monorepo. The `vercel.json` file configures the correct build commands:

```json
{
  "buildCommand": "cd ../.. && pnpm run build --filter=web",
  "installCommand": "cd ../.. && pnpm install"
}
```

### Database Connection Issues

Ensure your `DATABASE_URL` is correctly formatted:
```
postgresql://user:password@host:port/database?sslmode=require
```

### CLI Cannot Connect

1. Verify `VM0_API_URL` points to your deployment
2. If using token protection, ensure `VM0_TOKEN` matches `VM0_COMMUNITY_AUTH_TOKEN`
3. Check that your deployment is accessible (not blocked by firewall)

## Updating

To update your self-hosted instance:

1. Sync your forked repository with the upstream VM0 repo
2. Vercel will automatically redeploy on push to main

Or manually trigger a redeployment from the Vercel dashboard.
