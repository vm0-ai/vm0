# VM0 E2B Template

This directory contains the E2B sandbox template configuration for VM0 with Claude Code CLI.

## Quick Start

### 1. Install E2B Package

The E2B package is already included in the project dependencies.

### 2. Build the Template

```bash
cd turbo
pnpm e2b:build
```

This will:

- Build the template with Claude Code CLI installed
- Push it to E2B
- Output the template ID

### 3. Configure Template ID

Add the template ID to your environment:

```bash
# In turbo/.env.local
E2B_TEMPLATE_ID=<template-id-from-build-output>
```

## What's Included

The template includes:

- **Node.js 22.x** - For running npm packages
- **Claude Code CLI** - `@anthropic-ai/claude-code` installed globally
- **curl & jq** - For webhook communication
- **/opt/vm0** - Directory for VM0 scripts
- **/workspace** - Working directory for Claude Code

## Template Files

- `template.ts` - Template configuration using E2B TypeScript SDK
- `build.ts` - Build script to create and push the template
- `README.md` - This file

## Verifying the Template

After building, you can verify the template works:

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

## Updating the Template

If you need to update the template (e.g., install additional packages):

1. Edit `template.ts`
2. Run `pnpm e2b:build` again
3. Update `E2B_TEMPLATE_ID` with the new template ID

## Troubleshooting

### "E2B_API_KEY not found"

Set your E2B API key:

```bash
export E2B_API_KEY=your-api-key
# Or add to turbo/.env.local
```

### "Template build failed"

- Check your E2B account has available quota
- Verify your API key is valid
- Check E2B service status at https://status.e2b.dev

### "Claude not found in sandbox"

- Verify you set the correct `E2B_TEMPLATE_ID`
- Check the template was built successfully
- Try rebuilding the template

## Alternative: Using E2B CLI

You can also build templates using the E2B CLI:

```bash
# Using the old Dockerfile approach (deprecated)
cd turbo/apps/web/src/lib/e2b
e2b template build -n vm0-claude-code -c e2b.Dockerfile
```

However, the TypeScript SDK approach is preferred as it's more maintainable and consistent with the E2B ecosystem.
