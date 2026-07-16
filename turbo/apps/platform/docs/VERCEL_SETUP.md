# Vercel Setup for Platform Subproject

This document describes how to set up the Vercel project for the `turbo/apps/platform` subproject.

## Prerequisites

- Access to the Vercel team dashboard
- Admin access to GitHub repository settings

## Step 1: Create Vercel Project

1. Go to Vercel Dashboard
2. Click "Add New Project"
3. Import from GitHub repository
4. Configure the following settings:

| Setting          | Value                                      |
| ---------------- | ------------------------------------------ |
| Framework Preset | Vite                                       |
| Root Directory   | `turbo/apps/platform`                      |
| Build Command    | `cd ../.. && pnpm build --filter=@vm0/app` |
| Output Directory | `dist`                                     |
| Install Command  | `cd ../.. && pnpm install`                 |

## Step 2: Configure GitHub Repository Variable

1. Go to GitHub repository Settings > Secrets and variables > Actions > Variables
2. Add new repository variable:
   - Name: `VERCEL_PROJECT_ID_APP`
   - Value: (copy from Vercel project settings)

To find the Vercel Project ID:

1. Go to Vercel project settings
2. Navigate to "General" tab
3. Copy the "Project ID" value

## Step 3: Verify SPA Configuration

The platform already includes `vercel.json` with SPA rewrites that exclude
static assets and file-extension paths:

```json
{
  "rewrites": [
    { "source": "/((?!assets/|.*\\..*).*)", "destination": "/index.html" }
  ]
}
```

This ensures client-side routing works correctly without serving `index.html`
for missing static assets.

## Step 4: Test Deployment

1. Create a PR with changes to `turbo/apps/platform`
2. Verify the `deploy-platform` job triggers in CI
3. Check that preview URL is posted to PR

## Environment Variables

The app resolves its runtime environment from the browser domain. Production
hosts under `vm0.ai` use the canonical `api.vm0.ai` and `www.vm0.ai` services,
including when the same static artifact is served from an alternate app host.
Preview hosts preserve their branch prefix, so `pr-123-app.vm6.ai` resolves API
traffic to `pr-123-api.vm6.ai`.

Preview and production builds receive the same public configuration values.
The serving domain selects the active artifact CDN, hosted-site domain, and
telemetry configuration at runtime, so the built `dist` directory is portable
between supported deployment providers.

Alternate providers must serve the artifact from a hostname under the intended
environment domain. An unrecognized provider hostname is treated as preview
and cannot infer a separate API or web service origin.

| Variable                               | Description                      | Required         |
| -------------------------------------- | -------------------------------- | ---------------- |
| `VITE_CLERK_PUBLISHABLE_KEY_PREVIEW`   | Preview Clerk authentication     | For auth feature |
| `VITE_CLERK_PUBLISHABLE_KEY_PROD`      | Production Clerk authentication  | For auth feature |
| `VITE_VAPID_PUBLIC_KEY_PREVIEW`        | Preview Web Push subscription    | No               |
| `VITE_VAPID_PUBLIC_KEY_PROD`           | Production Web Push subscription | No               |
| `VITE_PLAUSIBLE_SCRIPT_URL_PREVIEW`    | Preview analytics script         | No               |
| `VITE_PLAUSIBLE_SCRIPT_URL_PRODUCTION` | Production analytics script      | No               |
| `VITE_POSTHOG_KEY`                     | Production product analytics     | No               |
| `VITE_SENTRY_DSN_PROD`                 | Production browser error intake  | No               |

## Troubleshooting

### Build Fails

- Ensure pnpm workspace is correctly configured
- Check that `@vm0/core` and `@vm0/ui` packages are built first

### Preview URL Not Posted

- Verify `VERCEL_PROJECT_ID_APP` is set correctly
- Check `VERCEL_TOKEN` and `VERCEL_TEAM_ID` secrets/variables exist

### 404 on Client-Side Routes

- Verify `vercel.json` is in the platform root directory
- Check that rewrites are correctly configured
