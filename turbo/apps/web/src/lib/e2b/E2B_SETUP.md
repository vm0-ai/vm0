# E2B Sandbox Setup

This document describes how to set up the E2B sandbox environment with Claude Code CLI.

## Prerequisites

1. Install E2B CLI:
```bash
npm install -g @e2b/cli
```

2. Authenticate with E2B:
```bash
e2b auth login
```

## Building the Custom Template

The custom E2B template includes:
- Claude Code CLI (@anthropic-ai/claude-code)
- curl and jq for webhook communication
- Pre-configured workspace directory

### Build and Push Template

```bash
cd turbo/apps/web/src/lib/e2b

# Build the template
e2b template build -n vm0-claude-code -c e2b.Dockerfile

# Push to E2B
e2b template push vm0-claude-code
```

This will output a template ID (e.g., `abcd1234efgh5678`).

## Configure Template ID

Update the template ID in `turbo/apps/web/src/lib/e2b/config.ts`:

```typescript
export const e2bConfig = {
  defaultTimeout: 600000, // 10 minutes
  defaultTemplate: "abcd1234efgh5678", // Your template ID
} as const;
```

Then update `e2b-service.ts` to use the template:

```typescript
private async createSandbox(): Promise<Sandbox> {
  const sandbox = await Sandbox.create({
    timeoutMs: e2bConfig.defaultTimeout,
    template: e2bConfig.defaultTemplate, // Use custom template
  });

  return sandbox;
}
```

## Environment Variables

Ensure the following environment variables are set:

- `E2B_API_KEY` - Your E2B API key
- `CLAUDE_CODE_OAUTH_TOKEN` or `DEFAULT_CLAUDE_TOKEN` - Claude API key (passed to sandbox)
- `VM0_API_URL` - VM0 API URL for webhook callbacks

## Testing the Template

You can test the template manually:

```bash
# Create a sandbox from the template
e2b sandbox create --template vm0-claude-code

# Test Claude Code is installed
e2b sandbox exec <sandbox-id> "claude --version"

# Test required tools
e2b sandbox exec <sandbox-id> "which curl jq"

# Cleanup
e2b sandbox kill <sandbox-id>
```

## Troubleshooting

### Claude Code not found
- Ensure the template build completed successfully
- Check that npm install didn't fail in the Dockerfile
- Verify the template was pushed correctly

### Timeout errors
- Increase `defaultTimeout` in config.ts (default: 10 minutes)
- Check E2B service status at https://status.e2b.dev

### Webhook connection failures
- Verify VM0_API_URL is accessible from E2B infrastructure
- Check webhook token generation is working
- Review E2B sandbox logs for connection errors

## Alternative: Using Pre-built Template

If E2B provides an official Claude Code template, you can use it instead:

1. Check available templates:
```bash
e2b template list
```

2. Update config.ts with the official template ID:
```typescript
export const e2bConfig = {
  defaultTimeout: 600000,
  defaultTemplate: "claude-code-official", // Official template
} as const;
```

This avoids the need to build and maintain a custom template.
