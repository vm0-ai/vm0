# E2B Sandbox Setup

This document describes how to set up the E2B sandbox environment with Claude Code CLI.

## Quick Start

### 1. Build the Template

```bash
cd turbo
pnpm e2b:build
```

This will:

- Build the E2B template with Claude Code CLI
- Push it to E2B
- Output the template ID

### 2. Configure Template Name

Add the template name to your environment:

```bash
# In turbo/.env.local
E2B_TEMPLATE_NAME=<template-name-from-build-output>
```

That's it! Your E2B sandbox is now ready to run Claude Code.

## What's Included

The custom E2B template includes:

- **Node.js 22.x** - For running npm packages
- **Claude Code CLI** - `@anthropic-ai/claude-code` installed globally
- **curl & jq** - For webhook communication
- **run-agent.sh** - Pre-installed at `/usr/local/bin/run-agent.sh` for executing Claude Code
- **/opt/vm0** - Directory for VM0 scripts (deprecated, kept for compatibility)
- **/workspace** - Working directory for Claude Code

## Prerequisites

Before building the template, ensure you have:

1. **E2B Account** - Sign up at https://e2b.dev
2. **E2B API Key** - Get it from https://e2b.dev/dashboard
3. **Environment Variables** - Set in `turbo/.env.local`:
   ```bash
   E2B_API_KEY=your-e2b-api-key
   ```

## Detailed Instructions

### Building the Template

The template is defined using the E2B TypeScript SDK in `template/template.ts`.

To build and push the template:

```bash
cd turbo
pnpm e2b:build
```

**Output:**

```
Building VM0 E2B template...
[Build logs...]
✅ Template built successfully!

📦 Template Name: vm0-claude-code

💡 Add this to your .env.local:
E2B_TEMPLATE_NAME=vm0-claude-code
```

### Configuring the Application

Update your environment configuration:

```bash
# turbo/.env.local
E2B_API_KEY=your-e2b-api-key
E2B_TEMPLATE_NAME=vm0-claude-code  # From build output
VM0_API_URL=http://localhost:3000  # Or your deployed URL
```

The E2B service will automatically use the template when `E2B_TEMPLATE_NAME` is set.

## Verifying the Template

Test that the template works correctly:

```bash
# Create a test sandbox
e2b sandbox create --template vm0-claude-code

# Test Claude Code is installed
e2b sandbox exec <sandbox-id> "claude --version"

# Test required tools
e2b sandbox exec <sandbox-id> "which curl jq"

# Cleanup
e2b sandbox kill <sandbox-id>
```

## Template Files

The template configuration is located in:

- `src/lib/e2b/template/template.ts` - Template configuration
- `src/lib/e2b/template/build.ts` - Build script
- `src/lib/e2b/template/README.md` - Detailed documentation

## Updating the Template

If you need to modify the template (e.g., install additional packages):

1. Edit `src/lib/e2b/template/template.ts`
2. Run `pnpm e2b:build` to rebuild
3. Update `E2B_TEMPLATE_NAME` with the new template name

Example - Adding a new tool:

```typescript
// In template.ts
export const vm0Template = Template()
  .fromImage("e2bdev/base")
  // ... existing setup ...
  .runCmd("sudo apt-get install -y git") // Add new tool
  .runCmd("git --version"); // Verify installation
```

## Troubleshooting

### "E2B_API_KEY not found"

**Solution:** Set your E2B API key in `.env.local`:

```bash
E2B_API_KEY=your-api-key
```

### Template build fails

**Possible causes:**

- E2B account quota exceeded
- Invalid API key
- E2B service issues

**Solutions:**

1. Check your E2B account quota at https://e2b.dev/dashboard
2. Verify your API key is correct
3. Check E2B status at https://status.e2b.dev

### "Claude not found" in sandbox

**Possible causes:**

- Template not built yet
- Wrong `E2B_TEMPLATE_NAME` configured
- Template build failed

**Solutions:**

1. Run `pnpm e2b:build` to build the template
2. Verify `E2B_TEMPLATE_NAME` matches the build output
3. Check build logs for errors

### Tests fail with "command not found"

**Expected behavior:** Tests will fail if `E2B_TEMPLATE_NAME` is not set.

**Solution:** Either:

1. Set `E2B_TEMPLATE_NAME` in your environment
2. Or skip tests that require Claude Code:
   ```typescript
   it.skipIf(!process.env.E2B_TEMPLATE_NAME)(
     'should execute Claude Code',
     async () => { ... }
   )
   ```

## Environment Variables

### Required

- `E2B_API_KEY` - E2B API key for creating sandboxes
- `VM0_API_URL` - VM0 API URL for webhook callbacks

### Optional

- `E2B_TEMPLATE_NAME` - Custom template name (if not set, uses default E2B image without Claude)

### Passed to Sandbox (Automatically)

- `VM0_RUN_ID` - Run UUID
- `VM0_WEBHOOK_URL` - Webhook endpoint URL
- `VM0_WEBHOOK_TOKEN` - Webhook auth token
- `VM0_PROMPT` - User prompt for Claude

## CI/CD Setup

### GitHub Actions

To use the custom template in CI:

1. Add E2B secrets to GitHub repository:
   - Go to Settings → Secrets and variables → Actions
   - Add `E2B_API_KEY`
   - Add `E2B_TEMPLATE_NAME` (after building locally)

2. Update workflow to use template:
   ```yaml
   env:
     E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
     E2B_TEMPLATE_NAME: ${{ secrets.E2B_TEMPLATE_NAME }}
   ```

### Vercel Deployment

Add environment variables in Vercel dashboard:

- `E2B_API_KEY`
- `E2B_TEMPLATE_NAME`

The template will be used automatically in production.

## Alternative: Dockerfile Approach (Deprecated)

The old Dockerfile approach (`e2b.Dockerfile`) is still available but deprecated:

```bash
# Old approach - not recommended
e2b template build -n vm0-claude-code -c e2b.Dockerfile
```

**Why deprecated:**

- Less maintainable
- Not consistent with E2B ecosystem
- Harder to version control changes

Use the TypeScript SDK approach instead (`pnpm e2b:build`).

## Next Steps

1. Build the template: `pnpm e2b:build`
2. Configure `E2B_TEMPLATE_NAME` in `.env.local`
3. Start the dev server: `pnpm dev`
4. Test creating a run: `curl -X POST http://localhost:3000/api/agent/runs ...`
5. Verify Claude Code output (not "Hello World from E2B!")

## Resources

- [E2B Documentation](https://e2b.dev/docs)
- [E2B TypeScript SDK](https://github.com/e2b-dev/e2b)
- [Claude Code CLI](https://github.com/anthropics/claude-code)
- [VM0 Template Source](./template/)
