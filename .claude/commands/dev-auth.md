---
command: dev-auth
description: Authenticate with local development server and get CLI token
---

Automates the CLI authentication flow against the local development server. This command uses Playwright to login via Clerk and authorize the CLI device code, then saves the auth token to `~/.uspark/config.json`.

Usage: `/dev-auth`

Prerequisites:
- Dev server must be running (use `/dev-start` first)
- Clerk test credentials must be configured in environment

## What to do:

1. **Check if dev server is running:**
   Use `/bashes` to list background shells and look for one running "pnpm dev".

   If no dev server found:
   ```
   ❌ No dev server found. Please run `/dev-start` first.
   ```
   Stop execution.

2. **Install CLI globally (if not already installed):**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm link --global
   ```

3. **Run authentication automation:**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT" && npx tsx e2e/cli-auth-automation.ts http://localhost:3000
   ```

4. **Verify authentication:**
   Check if auth token was saved:
   ```bash
   cat ~/.uspark/config.json
   ```

5. **Display results:**
   Show the auth status and token information:
   ```
   ✅ CLI authentication successful!

   Auth token saved to: ~/.uspark/config.json

   You can now use the CLI with local dev server:
   - uspark auth status
   - uspark project list
   ```

## Technical details:

The authentication script (`e2e/cli-auth-automation.ts`):
- Spawns `uspark auth login` with `API_HOST=http://localhost:3000`
- Launches Playwright browser in headless mode
- Logs in via Clerk using `e2e+clerk_test@vm0.ai`
- Automatically enters the CLI device code
- Clicks "Authorize Device" button
- Waits for authentication success
- Verifies token saved to `~/.uspark/config.json`

## Error handling:

If authentication fails:
- Check dev server logs with `/dev-logs`
- Verify Clerk test credentials are configured
- Try running manually: `cd $(git rev-parse --show-toplevel) && npx tsx e2e/cli-auth-automation.ts http://localhost:3000`
