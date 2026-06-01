# Required: Authentication (Clerk)
CLERK_SECRET_KEY=op://Development/clerk/CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY=op://Development/clerk/CLERK_PUBLISHABLE_KEY

# Required: Web app URL
APP_URL=https://app.vm7.ai:8443

# Required: API URL for web-owned server fetches
VM0_API_URL=https://api.vm7.ai:8443

# Optional: Backend API URL used by Next rewrites.
# Local dev defaults to http://localhost:3001 when this is unset.
VM0_API_BACKEND_URL=

# Required: Legacy file URL resolver storage
R2_ACCOUNT_ID=op://Development/cloudflare/R2_ACCOUNT_ID
R2_ACCESS_KEY_ID=op://Development/cloudflare/R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_SECRET_ACCESS_KEY
R2_USER_STORAGES_BUCKET_NAME=op://Development/cloudflare/R2_USER_STORAGES_BUCKET_NAME
R2_USER_ARTIFACTS_BUCKET_NAME=user-artifact-dev
R2_USER_ARTIFACTS_ACCESS_KEY_ID=op://Development/cloudflare/R2_USER_ARTIFACTS_ACCESS_KEY_ID
R2_USER_ARTIFACTS_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_USER_ARTIFACTS_SECRET_ACCESS_KEY
PUBLIC_ARTIFACTS_BASE_URL=https://cdn.vm7.io

# Optional: Monday.com app association endpoint
MONDAY_OAUTH_CLIENT_ID=op://Development/monday/MONDAY_OAUTH_CLIENT_ID
MONDAY_OAUTH_APP_ID=op://Development/monday/MONDAY_OAUTH_APP_ID

# Optional: Blog configuration
BLOG_BASE_URL=
BLOG_DATA_SOURCE=strapi
STRAPI_URL=

# Optional: Search verification
GOOGLE_SITE_VERIFICATION=

# Optional: Analytics (Plausible)
PLAUSIBLE_SCRIPT_URL=

# Optional: Error tracking (Sentry)
SENTRY_DSN_WEB=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=

# Optional: Paid-onboarding origin
PAID_ONBOARDING_URL=

# Optional: Vercel preview proxy bypass
VERCEL_AUTOMATION_BYPASS_SECRET=
