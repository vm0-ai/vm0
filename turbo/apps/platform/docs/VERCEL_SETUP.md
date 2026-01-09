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

| Setting          | Value                                           |
| ---------------- | ----------------------------------------------- |
| Framework Preset | Vite                                            |
| Root Directory   | `turbo/apps/platform`                           |
| Build Command    | `cd ../.. && pnpm build --filter=@vm0/platform` |
| Output Directory | `dist`                                          |
| Install Command  | `cd ../.. && pnpm install`                      |

## Step 2: Configure GitHub Repository Variable

1. Go to GitHub repository Settings > Secrets and variables > Actions > Variables
2. Add new repository variable:
   - Name: `VERCEL_PROJECT_ID_PLATFORM`
   - Value: (copy from Vercel project settings)

To find the Vercel Project ID:

1. Go to Vercel project settings
2. Navigate to "General" tab
3. Copy the "Project ID" value

## Step 3: Verify SPA Configuration

The platform already includes `vercel.json` with SPA rewrites:

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

This ensures client-side routing works correctly.

## Step 4: Test Deployment

1. Create a PR with changes to `turbo/apps/platform`
2. Verify the `deploy-platform` job triggers in CI
3. Check that preview URL is posted to PR

## Environment Variables (Optional)

For future features, these variables may be needed:

| Variable                     | Description          | Required            |
| ---------------------------- | -------------------- | ------------------- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk authentication | For auth feature    |
| `VITE_API_URL`               | Backend API URL      | For API integration |

## Troubleshooting

### Build Fails

- Ensure pnpm workspace is correctly configured
- Check that `@vm0/core` and `@vm0/ui` packages are built first

### Preview URL Not Posted

- Verify `VERCEL_PROJECT_ID_PLATFORM` is set correctly
- Check `VERCEL_TOKEN` and `VERCEL_TEAM_ID` secrets/variables exist

### 404 on Client-Side Routes

- Verify `vercel.json` is in the platform root directory
- Check that rewrites are correctly configured
