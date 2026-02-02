# Required: Authentication (Clerk)
CLERK_SECRET_KEY=op://Development/vm0-env-local/clerk_secret_key
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=op://Development/vm0-env-local/clerk_publishable_key

# Required: Sandbox Runtime (E2B)
E2B_API_KEY=op://Development/vm0-env-local/e2b_api_key
E2B_TEMPLATE_NAME=vm0-claude-code-dev

# Required: Object Storage (Cloudflare R2)
R2_ACCOUNT_ID=op://Development/vm0-env-local/r2_account_id
R2_ACCESS_KEY_ID=op://Development/vm0-env-local/r2_access_key_id
R2_SECRET_ACCESS_KEY=op://Development/vm0-env-local/r2_secret_access_key
R2_USER_STORAGES_BUCKET_NAME=op://Development/vm0-env-local/r2_user_storages_bucket_name

# Optional: Observability (Axiom)
AXIOM_TOKEN=op://Development/vm0-env-local/axiom_token
AXIOM_DATASET_SUFFIX=dev

SECRETS_ENCRYPTION_KEY=op://Development/vm0-env-local/SECRETS_ENCRYPTION_KEY

# Optional: Slack Integration
SLACK_CLIENT_ID=op://Development/vm0-env-local/slack_client_id
SLACK_CLIENT_SECRET=op://Development/vm0-env-local/slack_client_secret
SLACK_SIGNING_SECRET=op://Development/vm0-env-local/slack_signing_secret
SLACK_REDIRECT_BASE_URL=

# Required: Claude Code Version URL
CLAUDE_CODE_VERSION_URL=https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest
