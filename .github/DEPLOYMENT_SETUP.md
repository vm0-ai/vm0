# Preview Deployment Setup

This repository is configured to automatically create preview deployments for pull requests using Vercel and Neon database branches.

⚠️ **Important**: The preview deployment workflow will fail until the required secrets are configured. This is expected behavior.

## How It Works

1. **Automatic Deployments Disabled**: Vercel's automatic Git deployments are disabled via `vercel.json`
2. **PR Opens**: When a PR is opened, the CI workflow:
   - Creates a new Neon database branch named `preview-pr-{PR_NUMBER}`
   - Runs database migrations on the branch
   - Deploys to Vercel with the branch database URL
   - Creates stable alias URLs (if `PREVIEW_DOMAIN` is configured)
   - Comments on the PR with deployment links
3. **PR Updates**: On new commits, the deployment is updated
4. **PR Closes**: When merged or closed, the Neon branch is automatically deleted

## Stable Preview URLs

When the `PREVIEW_DOMAIN` variable is configured, preview deployments get predictable alias URLs:

| App      | Preview URL Pattern                   |
| -------- | ------------------------------------- |
| Web      | `{job-ref}-www.{PREVIEW_DOMAIN}`      |
| Platform | `{job-ref}-platform.{PREVIEW_DOMAIN}` |
| Site     | `{job-ref}-site.{PREVIEW_DOMAIN}`     |
| Docs     | `{job-ref}-docs.{PREVIEW_DOMAIN}`     |

Where `{job-ref}` is `pr-{number}` for pull requests (e.g., `pr-123-www.vm6.ai`).

### Prerequisites for Stable Preview URLs

1. **DNS Configuration**: Add wildcard CNAME record pointing to Vercel:
   | Type | Name | Value |
   |------|------|-------|
   | CNAME | `*` | `cname.vercel-dns.com` |

2. **Vercel Domain Configuration**:
   - Go to Vercel Dashboard → Team Settings → Domains
   - Add `*.{PREVIEW_DOMAIN}` as a wildcard domain
   - Verify domain ownership

3. **GitHub Repository Variable**:
   | Name | Value |
   |------|-------|
   | `PREVIEW_DOMAIN` | Your preview domain (e.g., `vm6.ai`) |

## Required GitHub Secrets and Variables

Configure these in your GitHub repository settings (Settings → Secrets and variables → Actions):

### Secrets (Store as Secrets)

- `VERCEL_TOKEN`: Your Vercel personal access token
  - Generate at: https://vercel.com/account/tokens
- `NEON_API_KEY`: Your Neon API key (Optional but Recommended)
  - Generate at: https://console.neon.tech/app/settings/api-keys
- `CLERK_SECRET_KEY`: Your Clerk secret key (Required)
  - Get from: https://dashboard.clerk.com
- `E2B_API_KEY`: Your E2B API key (Optional)
  - Get from: https://e2b.dev/dashboard
- `E2B_TEMPLATE_NAME`: Custom E2B template name (Optional)
  - Generate by running `cd turbo && pnpm e2b:build`

### Variables (Store as Repository Variables)

- `VERCEL_TEAM_ID`: Your Vercel team/organization ID
  - Find in Vercel project settings → General → Team ID
- `VERCEL_PROJECT_ID_WEB`: Your Vercel project ID for web app
  - Find in Vercel project settings → General → Project ID
- `VERCEL_PROJECT_ID_DOCS`: Your Vercel project ID for docs app
  - Find in Vercel project settings → General → Project ID
- `NEON_PROJECT_ID`: Your Neon project ID (Optional but Recommended)
  - Find in Neon console → Project Settings → General
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: Your Clerk publishable key (Required)
  - Get from: https://dashboard.clerk.com
- `PREVIEW_DOMAIN`: Domain for stable preview URLs (Optional)
  - Example: `vm6.ai`
  - Requires wildcard DNS and Vercel domain configuration (see "Stable Preview URLs" section)

**Note**: If Neon secrets are not configured, the deployment will still work but without database branching.

## Initial Setup

1. **Configure Vercel Project Settings**:
   - Go to your Vercel project settings: https://vercel.com/[your-team]/vm0/settings
   - Under "General" → "Root Directory", set it to: `turbo/apps/web`
   - Save the changes

2. Set up your production database in Neon

3. Add all required secrets and variables to GitHub (see above)

4. The workflow will automatically handle preview deployments for PRs

**Important**: The Vercel project must be configured with the correct root directory (`turbo/apps/web`) for the monorepo structure to work properly.

## Database Schema Push

The workflow automatically pushes database schema to preview branches using:

```bash
pnpm db:push
```

This uses Drizzle Kit to push your schema defined in `turbo/apps/web/src/db/schema/` to the Neon database branch.

## Environment Variables Details

### Required Variables

These must be configured for the application to work:

- **CLERK_SECRET_KEY**: Required for user authentication
- **NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY**: Required for Clerk client-side SDK
- **DATABASE_URL**: Automatically injected by the workflow from Neon

### Optional E2B Configuration

For running agent code in sandboxes:

- **E2B_API_KEY**: Your E2B API key for creating sandboxes
- **E2B_TEMPLATE_NAME**: Custom template with Claude Code CLI pre-installed
  - Build template: `cd turbo && pnpm e2b:build`
  - Without this, the default E2B image is used (Claude Code must be manually installed)

### Anthropic-Compatible API Configuration

To use Anthropic-compatible model providers (e.g., Anthropic, Minimax, or custom providers), configure environment variables in your Agent Compose YAML using user secrets:

```yaml
# vm0.config.yaml
environment:
  ANTHROPIC_BASE_URL: ${{ secrets.ANTHROPIC_BASE_URL }}
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.ANTHROPIC_API_KEY }}
  ANTHROPIC_MODEL: ${{ secrets.ANTHROPIC_MODEL }}
  # ... other model aliases as needed
```

Set up secrets using the VM0 CLI:

```bash
vm0 secret set ANTHROPIC_BASE_URL "https://your-api-endpoint.com"
vm0 secret set ANTHROPIC_API_KEY "your-api-key"
vm0 secret set ANTHROPIC_MODEL "your-model-name"
```

### How Environment Variables are Injected

The workflow uses two methods to inject environment variables into Vercel deployments:

1. **GitHub Actions → Vercel CLI** (Recommended for sensitive values)
   - Secrets are stored in GitHub and passed to Vercel during deployment
   - Used for: `CLERK_SECRET_KEY`, `E2B_API_KEY`, etc.
   - See `.github/workflows/release-please.yml` and `.github/workflows/turbo.yml`

2. **Vercel Dashboard** (Alternative method)
   - Environment variables can also be set directly in Vercel project settings
   - Go to: Project Settings → Environment Variables
   - Useful for overriding values or configuring additional environments

**Note**: GitHub Actions method takes precedence and is recommended for security and consistency across deployments.
