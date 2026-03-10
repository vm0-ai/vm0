# Database driver (pg for local Postgres, neon for serverless)
DB_DRIVER=pg

# Required: Authentication (Clerk)
CLERK_SECRET_KEY=op://Development/clerk/CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY=op://Development/clerk/CLERK_PUBLISHABLE_KEY

# Required: Sandbox Runtime (E2B)
E2B_API_KEY=op://Development/e2b/E2B_API_KEY
E2B_TEMPLATE_NAME=vm0-claude-code-dev

# Required: Object Storage (Cloudflare R2)
R2_ACCOUNT_ID=op://Development/cloudflare/R2_ACCOUNT_ID
R2_ACCESS_KEY_ID=op://Development/cloudflare/R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_SECRET_ACCESS_KEY
R2_USER_STORAGES_BUCKET_NAME=op://Development/cloudflare/R2_USER_STORAGES_BUCKET_NAME

# Optional: Observability (Axiom)
AXIOM_TOKEN_SESSIONS=op://Development/axiom/AXIOM_TOKEN_SESSIONS
AXIOM_TOKEN_TELEMETRY=op://Development/axiom/AXIOM_TOKEN_TELEMETRY
AXIOM_DATASET_SUFFIX=dev

SECRETS_ENCRYPTION_KEY=op://Development/vm0/SECRETS_ENCRYPTION_KEY

# Optional: Slack Integration
SLACK_CLIENT_ID=op://Development/slack/SLACK_CLIENT_ID
SLACK_CLIENT_SECRET=op://Development/slack/SLACK_CLIENT_SECRET
SLACK_SIGNING_SECRET=op://Development/slack/SLACK_SIGNING_SECRET
VM0_DEFAULT_AGENT=op://Development/vm0/VM0_DEFAULT_AGENT

# Required: Claude Code Version URL
CLAUDE_CODE_VERSION_URL=https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest

# Optional: LLM API (OpenRouter)
OPENROUTER_API_KEY=op://Development/openrouter/OPENROUTER_API_KEY

# Optional: Airtable OAuth Connector
AIRTABLE_OAUTH_CLIENT_ID=op://Development/airtable/AIRTABLE_OAUTH_CLIENT_ID
AIRTABLE_OAUTH_CLIENT_SECRET=op://Development/airtable/AIRTABLE_OAUTH_CLIENT_SECRET

# Optional: GitHub OAuth Connector
GH_OAUTH_CLIENT_ID=op://Development/github/GH_OAUTH_CLIENT_ID
GH_OAUTH_CLIENT_SECRET=op://Development/github/GH_OAUTH_CLIENT_SECRET

# Optional: Notion OAuth Connector
NOTION_OAUTH_CLIENT_ID=op://Development/notion/NOTION_OAUTH_CLIENT_ID
NOTION_OAUTH_CLIENT_SECRET=op://Development/notion/NOTION_OAUTH_CLIENT_SECRET

# Optional: Google OAuth Connector (Gmail, Calendar, Drive, etc.)
GOOGLE_OAUTH_CLIENT_ID=op://Development/google/GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET=op://Development/google/GOOGLE_OAUTH_CLIENT_SECRET

# Optional: Microsoft OAuth Connector (Outlook Calendar, etc.)
MICROSOFT_OAUTH_CLIENT_ID=op://Development/microsoft/MICROSOFT_OAUTH_CLIENT_ID
MICROSOFT_OAUTH_CLIENT_SECRET=op://Development/microsoft/MICROSOFT_OAUTH_CLIENT_SECRET

# Optional: HubSpot OAuth Connector
HUBSPOT_OAUTH_CLIENT_ID=op://Development/hubspot/HUBSPOT_OAUTH_CLIENT_ID
HUBSPOT_OAUTH_CLIENT_SECRET=op://Development/hubspot/HUBSPOT_OAUTH_CLIENT_SECRET

# Optional: Close OAuth Connector
CLOSE_OAUTH_CLIENT_ID=op://Development/close/CLOSE_OAUTH_CLIENT_ID
CLOSE_OAUTH_CLIENT_SECRET=op://Development/close/CLOSE_OAUTH_CLIENT_SECRET

# Optional: Deel OAuth Connector
DEEL_OAUTH_CLIENT_ID=op://Development/deel/DEEL_OAUTH_CLIENT_ID
DEEL_OAUTH_CLIENT_SECRET=op://Development/deel/DEEL_OAUTH_CLIENT_SECRET

# Optional: DocuSign OAuth Connector
DOCUSIGN_OAUTH_CLIENT_ID=op://Development/docusign/DOCUSIGN_OAUTH_CLIENT_ID
DOCUSIGN_OAUTH_CLIENT_SECRET=op://Development/docusign/DOCUSIGN_OAUTH_CLIENT_SECRET

# Optional: Dropbox OAuth Connector
DROPBOX_OAUTH_CLIENT_ID=op://Development/dropbox/DROPBOX_OAUTH_CLIENT_ID
DROPBOX_OAUTH_CLIENT_SECRET=op://Development/dropbox/DROPBOX_OAUTH_CLIENT_SECRET

# Optional: Linear OAuth Connector
LINEAR_OAUTH_CLIENT_ID=op://Development/linear/LINEAR_OAUTH_CLIENT_ID
LINEAR_OAUTH_CLIENT_SECRET=op://Development/linear/LINEAR_OAUTH_CLIENT_SECRET

# Optional: Figma OAuth Connector
FIGMA_OAUTH_CLIENT_ID=op://Development/figma/FIGMA_OAUTH_CLIENT_ID
FIGMA_OAUTH_CLIENT_SECRET=op://Development/figma/FIGMA_OAUTH_CLIENT_SECRET

# Optional: Strava OAuth Connector
STRAVA_OAUTH_CLIENT_ID=op://Development/strava/STRAVA_OAUTH_CLIENT_ID
STRAVA_OAUTH_CLIENT_SECRET=op://Development/strava/STRAVA_OAUTH_CLIENT_SECRET

# Optional: X OAuth Connector
X_OAUTH_CLIENT_ID=op://Development/x/X_OAUTH_CLIENT_ID
X_OAUTH_CLIENT_SECRET=op://Development/x/X_OAUTH_CLIENT_SECRET

# Optional: Vercel OAuth Connector
VERCEL_OAUTH_CLIENT_ID=op://Development/vercel/VERCEL_OAUTH_CLIENT_ID
VERCEL_OAUTH_CLIENT_SECRET=op://Development/vercel/VERCEL_OAUTH_CLIENT_SECRET
VERCEL_INTEGRATION_SLUG=op://Development/vercel/VERCEL_INTEGRATION_SLUG

# Optional: Sentry OAuth Connector
SENTRY_OAUTH_CLIENT_ID=op://Development/sentry/SENTRY_OAUTH_CLIENT_ID
SENTRY_OAUTH_CLIENT_SECRET=op://Development/sentry/SENTRY_OAUTH_CLIENT_SECRET

# Optional: Intervals.icu OAuth Connector
INTERVALS_ICU_OAUTH_CLIENT_ID=op://Development/intervals-icu/INTERVALS_ICU_OAUTH_CLIENT_ID
INTERVALS_ICU_OAUTH_CLIENT_SECRET=op://Development/intervals-icu/INTERVALS_ICU_OAUTH_CLIENT_SECRET

# Optional: Xero OAuth Connector
XERO_OAUTH_CLIENT_ID=op://Development/xero/XERO_OAUTH_CLIENT_ID
XERO_OAUTH_CLIENT_SECRET=op://Development/xero/XERO_OAUTH_CLIENT_SECRET

# Optional: Todoist OAuth Connector
TODOIST_OAUTH_CLIENT_ID=op://Development/todoist/TODOIST_OAUTH_CLIENT_ID
TODOIST_OAUTH_CLIENT_SECRET=op://Development/todoist/TODOIST_OAUTH_CLIENT_SECRET

# Optional: Monday.com OAuth Connector
MONDAY_OAUTH_CLIENT_ID=op://Development/monday/MONDAY_OAUTH_CLIENT_ID
MONDAY_OAUTH_CLIENT_SECRET=op://Development/monday/MONDAY_OAUTH_CLIENT_SECRET
MONDAY_OAUTH_APP_ID=op://Development/monday/MONDAY_OAUTH_APP_ID

# Optional: Wix OAuth Connector
WIX_OAUTH_CLIENT_ID=op://Development/wix/WIX_OAUTH_CLIENT_ID
WIX_OAUTH_CLIENT_SECRET=op://Development/wix/WIX_OAUTH_CLIENT_SECRET

# Optional: Meta Ads OAuth Connector
META_ADS_OAUTH_CLIENT_ID=op://Development/meta-ads/META_ADS_OAUTH_CLIENT_ID
META_ADS_OAUTH_CLIENT_SECRET=op://Development/meta-ads/META_ADS_OAUTH_CLIENT_SECRET

# Optional: Canva OAuth Connector
CANVA_OAUTH_CLIENT_ID=op://Development/canva/CANVA_OAUTH_CLIENT_ID
CANVA_OAUTH_CLIENT_SECRET=op://Development/canva/CANVA_OAUTH_CLIENT_SECRET

# Optional: Webflow OAuth Connector
WEBFLOW_OAUTH_CLIENT_ID=op://Development/webflow/WEBFLOW_OAUTH_CLIENT_ID
WEBFLOW_OAUTH_CLIENT_SECRET=op://Development/webflow/WEBFLOW_OAUTH_CLIENT_SECRET

# Optional: PostHog OAuth Connector
POSTHOG_OAUTH_CLIENT_ID=op://Development/posthog/POSTHOG_OAUTH_CLIENT_ID
POSTHOG_OAUTH_CLIENT_SECRET=op://Development/posthog/POSTHOG_OAUTH_CLIENT_SECRET

# Optional: Stripe OAuth Connector
STRIPE_OAUTH_CLIENT_ID=op://Development/stripe/STRIPE_OAUTH_CLIENT_ID
STRIPE_OAUTH_CLIENT_SECRET=op://Development/stripe/STRIPE_OAUTH_CLIENT_SECRET

# Optional: ngrok (Computer Connector)
NGROK_API_KEY=op://Development/ngrok/NGROK_API_KEY
NGROK_COMPUTER_CONNECTOR_DOMAIN=computer.vm7.io

# Required: Platform UI URL (for settings page links in error messages)
PLATFORM_URL=op://Development/vm0/PLATFORM_URL

# Optional: Blog Configuration
BLOG_BASE_URL=
BLOG_DATA_SOURCE=strapi
STRAPI_URL=

# Optional: Error Tracking (Sentry)
# Sentry DSN (used by both server and client)
SENTRY_DSN_WEB=
# Sentry build configuration
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=

# Optional: VM0 Admin Users (comma-separated emails for super-admin access)
# VM0_ADMIN_USERS=lancy@vm0.ai,ethan@vm0.ai

# Optional: Github App for Integration
GITHUB_APP_CLIENT_ID=op://Development/github/GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET=op://Development/github/GITHUB_APP_CLIENT_SECRET
GITHUB_APP_ID=op://Development/github/GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY=op://Development/github/GITHUB_APP_PRIVATE_KEY
GITHUB_APP_SLUG=op://Development/github/GITHUB_APP_SLUG
GITHUB_APP_WEBHOOK_SECRET=op://Development/github/GITHUB_APP_WEBHOOK_SECRET

# Optional: Self-hosted Runner (for local development with runner on dev-1)
# RUNNER_DEFAULT_GROUP is auto-configured by sync-env.sh — do not add here
OFFICIAL_RUNNER_SECRET=op://Development/vm0/OFFICIAL_RUNNER_SECRET
