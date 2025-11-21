# E2B Template for VM0

This directory contains the E2B sandbox template configuration for running Claude Code agents.

## Build System 2.0

This template uses **E2B Build System 2.0** - the modern, programmatic approach to defining sandbox templates. Templates are expressed as TypeScript code rather than Dockerfiles, making them AI-friendly and easier to maintain.

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

## Automated Builds

Templates are automatically built and deployed via GitHub Actions when changes are pushed to the `e2b/` directory:

- **Pull Requests**: Templates are built to validate changes
- **Main Branch**: Templates are built and deployed automatically

To trigger a build, simply push changes to any file in the `e2b/` directory.

## Manual Builds

For local development and testing, you can manually build templates:

```bash
# 1. Set up environment variables
# Add your E2B API key to turbo/apps/web/.env.local:
echo "E2B_API_KEY=your_api_key_here" >> turbo/apps/web/.env.local

# 2. Build and push the template from the turbo directory
cd turbo

# Development build
pnpm e2b:build:dev

# Production build
pnpm e2b:build

# The template will be created with an alias:
# - Development: vm0-claude-code-dev
# - Production: vm0-claude-code
```

## Configuration

### Build Configuration

Update these if template name changes:
- `turbo/apps/web/.env.local` - E2B_TEMPLATE_NAME=vm0-claude-code
- GitHub secrets - E2B_API_KEY (for automated builds)
- Vercel environment variables - E2B_TEMPLATE_NAME

### Runtime Environment Variables

The following environment variables are set when creating a sandbox:

- `VM0_RUN_ID`: Unique identifier for this agent run execution
- `VM0_WEBHOOK_URL`: URL to send execution events to
- `VM0_TOKEN`: Authentication token for webhook requests
- `VM0_PROMPT`: The prompt for Claude Code to execute
- `ANTHROPIC_BASE_URL`: Base URL for Anthropic API (optional, for custom endpoints)
- `ANTHROPIC_AUTH_TOKEN`: Authentication token for Claude API

## Script Behavior

The `run-agent.sh` script:
1. Reads the prompt from environment variable `VM0_PROMPT`
2. Executes Claude Code with streaming JSON output
3. Batches events and sends them to the webhook URL
4. Returns exit code 0 on success, non-zero on failure
