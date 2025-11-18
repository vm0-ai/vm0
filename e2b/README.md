# E2B Template for VM0

This directory contains the E2B sandbox template configuration for running Claude Code agents.

## Files

- `template.ts`: E2B v2 template definition using programmatic SDK
- `build.dev.ts`: Development build script
- `build.prod.ts`: Production build script
- `run-agent.sh`: Shell script that executes Claude Code and sends events to the webhook

## How It Works

1. **Build Phase**: The template SDK programmatically builds a Docker image with:
   - Node.js 22 base image
   - Git, curl, jq utilities
   - Claude Code CLI pre-installed globally
   - `run-agent.sh` script copied to `/usr/local/bin/run-agent.sh`
2. **Runtime Phase**: When creating a sandbox, the script is already available and can be executed directly
3. **Execution**: The e2b-service.ts calls `/usr/local/bin/run-agent.sh` with environment variables

## Building and Deploying the Template

This template uses E2B v2 SDK. To build and deploy a new version:

```bash
# From the e2b directory
cd e2b

# Install dependencies (first time only)
npm install

# Build and push the template
E2B_API_KEY=your_api_key npx tsx build.prod.ts

# Note the template ID from the output (format: namnmt5bl80j5oon0pr6)
# Update it in:
# - turbo/apps/web/.env.local (E2B_TEMPLATE_ID=...)
# - GitHub secrets (E2B_TEMPLATE_ID)
# - Vercel environment variables (E2B_TEMPLATE_ID)
```

## Environment Variables

The following environment variables are set when creating a sandbox:

- `VM0_RUNTIME_ID`: Unique identifier for this runtime execution
- `VM0_WEBHOOK_URL`: URL to send execution events to
- `VM0_WEBHOOK_TOKEN`: Authentication token for webhook requests
- `ANTHROPIC_BASE_URL`: Base URL for Anthropic API (optional, for custom endpoints)
- `ANTHROPIC_AUTH_TOKEN`: Authentication token for Claude API

## Script Behavior

The `run-agent.sh` script:
1. Reads the prompt from environment variable `VM0_PROMPT`
2. Executes Claude Code with streaming JSON output
3. Batches events and sends them to the webhook URL
4. Returns exit code 0 on success, non-zero on failure
