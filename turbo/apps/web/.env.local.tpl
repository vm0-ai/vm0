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

# Optional: Realtime (Ably) — required for runner realtime token endpoint
ABLY_API_KEY=op://Development/ably/ABLY_API_KEY

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

# Optional: Analytics (Plausible)
PLAUSIBLE_SCRIPT_URL=

# Required: OpenAI (voice-chat ephemeral token minting, STT, TTS)
OPENAI_API_KEY=op://Development/openai/OPENAI_API_KEY

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

# Optional: Stripe OAuth Connector
STRIPE_OAUTH_CLIENT_ID=op://Development/stripe/STRIPE_OAUTH_CLIENT_ID
STRIPE_OAUTH_CLIENT_SECRET=op://Development/stripe/STRIPE_OAUTH_CLIENT_SECRET

# Optional: Stripe Billing (Vercel AI Gateway metering)
STRIPE_VERCEL_GATEWAY_REPORT_ACCESS_KEY=op://Development/stripe/STRIPE_VERCEL_GATEWAY_REPORT_ACCESS_KEY

# Optional: Stripe Billing (subscription + credits)
STRIPE_SECRET_KEY=op://Development/stripe/STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET=op://Development/stripe/STRIPE_WEBHOOK_SECRET
ZERO_PRICE=op://Development/stripe/ZERO_PRICE
ZERO_ONE_TIME_CAMPAIGN=op://Development/stripe/ZERO_ONE_TIME_CAMPAIGN

# Optional: AgentPhone (Phone Channel)
AGENTPHONE_API_KEY=op://Development/agentphone/AGENTPHONE_API_KEY

# Optional: Plain.com (Developer Support)
PLAIN_API_KEY=op://Development/plain/PLAIN_API_KEY

# Optional: ngrok (Computer Connector)
NGROK_API_KEY=op://Development/ngrok/NGROK_API_KEY
NGROK_COMPUTER_CONNECTOR_DOMAIN=computer.vm7.io

# Required: App UI URL (for settings page links in error messages)
APP_URL=https://app.vm7.ai:8443

# Optional: Web app URL — apps/api proxies any unmatched route here while
# legacy endpoints are migrated. Leave unset to fall through to a plain 404.
VM0_WEB_URL=https://www.vm7.ai:8443

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

# Optional: Github App for Integration
GITHUB_APP_CLIENT_ID=op://Development/github/GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET=op://Development/github/GITHUB_APP_CLIENT_SECRET
GITHUB_APP_ID=op://Development/github/GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY=op://Development/github/GITHUB_APP_PRIVATE_KEY
GITHUB_APP_SLUG=op://Development/github/GITHUB_APP_SLUG
GITHUB_APP_WEBHOOK_SECRET=op://Development/github/GITHUB_APP_WEBHOOK_SECRET

# Optional: VM0 Managed Model Provider API Keys
DEV_MODEL_ANTHROPIC_KEY=op://Development/anthropic/DEV_MODEL_ANTHROPIC_KEY
DEV_MODEL_MOONSHOT_KEY=op://Development/moonshot/DEV_MODEL_MOONSHOT_KEY
DEV_MODEL_ZAI_KEY=op://Development/z.ai/DEV_MODEL_ZAI_KEY
DEV_MODEL_MINIMAX_KEY=op://Development/minimax/DEV_MODEL_MINIMAX_KEY

# Optional: Gemini Developer API key (for /api/generate-image in local dev).
# Production uses Vertex AI via OIDC federation; see GCP_* vars injected by CI.
GEMINI_API_KEY=op://Development/gemini/GEMINI_API_KEY

# Optional: Web Push (VAPID) — for PWA push notifications
VAPID_PUBLIC_KEY=op://Development/vapid/VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=op://Development/vapid/VAPID_PRIVATE_KEY

# Optional: Self-hosted Runner (for local development with runner on dev-1)
# RUNNER_DEFAULT_GROUP is auto-configured by sync-env.sh — do not add here
OFFICIAL_RUNNER_SECRET=0000000000000000000000000000000000000000000000000000000000000000

# Required for the dev-only cron scheduler that emulates vercel.json crons in
# `pnpm dev`. A fixed local value is fine — production uses a Vercel-managed
# secret and never touches this file.
CRON_SECRET=local-dev-cron-secret
