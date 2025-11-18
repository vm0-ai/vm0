# E2B Template for VM0

This directory contains the E2B sandbox template configuration for running Claude Code agents.

## Files

- `e2b.Dockerfile`: Docker image configuration with Claude Code CLI and run-agent.sh script pre-installed
- `e2b.toml`: E2B template configuration file
- `run-agent.sh`: Shell script that executes Claude Code and sends events to the webhook

## How It Works

1. **Build Phase**: The Dockerfile copies `run-agent.sh` into the image at `/usr/local/bin/run-agent.sh`
2. **Runtime Phase**: When creating a sandbox, the script is already available and can be executed directly
3. **Execution**: The e2b-service.ts calls `/usr/local/bin/run-agent.sh` with environment variables

## Building and Deploying the Template

To build and deploy a new version of the E2B template:

```bash
# Install E2B CLI if not already installed
npm install -g @e2b/cli

# Login to E2B
e2b auth login

# Build and push the template (from this directory)
cd e2b
e2b template build

# Note the template ID from the output and update it in:
# turbo/apps/web/src/lib/e2b/config.ts
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
