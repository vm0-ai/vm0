---
command: dev-tunnel
description: Start dev server with Cloudflare tunnel and authenticate CLI
---

Starts the development server with a Cloudflare tunnel for webhook testing, installs dependencies, builds the project, and authenticates the CLI.

Usage: `/dev-tunnel`

## What to do:

1. **Install dependencies:**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/turbo" && pnpm install
   ```

2. **Build the project:**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/turbo" && pnpm build
   ```

3. **Start dev server with tunnel:**
   Use Bash tool with `run_in_background: true`:
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/turbo" && pnpm dev:tunnel
   ```

4. **Wait for tunnel URL:**
   Monitor the background shell output using `BashOutput` until you see:
   - "Tunnel URL:" followed by the URL
   - "Next.js dev server is ready!"

   Extract the tunnel URL from the output (format: `https://*.trycloudflare.com`).

5. **Export VM0_API_URL:**
   ```bash
   export VM0_API_URL=<tunnel-url>
   ```

6. **Install e2e dependencies (if needed):**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/e2e" && pnpm install
   ```

7. **Install Playwright browser (if needed):**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/e2e" && npx playwright install chromium
   ```

8. **Install CLI globally:**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm link --global
   ```

9. **Run CLI authentication:**
   Read Clerk credentials from `turbo/apps/web/.env.local`:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` -> `CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY` -> `CLERK_SECRET_KEY`

   Then run:
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/e2e" && \
   CLERK_PUBLISHABLE_KEY=<publishable-key> \
   CLERK_SECRET_KEY=<secret-key> \
   npx tsx cli-auth-automation.ts http://localhost:3000
   ```

10. **Verify authentication:**
    ```bash
    cat ~/.vm0/config.json
    ```

11. **Display results:**
    ```
    ✅ Dev server with tunnel started!

    Local:   http://localhost:3000
    Tunnel:  <tunnel-url>

    VM0_API_URL exported to: <tunnel-url>

    ✅ CLI authentication successful!
    Auth token saved to: ~/.vm0/config.json

    You can now test E2B webhooks locally:
      vm0 run <agent-name> "<prompt>"

    Use `/dev-stop` to stop the server.
    ```

## Technical details:

The `pnpm dev:tunnel` script:
- Starts a Cloudflare tunnel using `cloudflared`
- Exposes localhost:3000 to the internet
- Sets `VM0_API_URL` environment variable for the dev server
- Starts Next.js dev server with Turbopack

The authentication script (`e2e/cli-auth-automation.ts`):
- Spawns `vm0 auth login` with `VM0_API_URL=http://localhost:3000`
- Launches Playwright browser in headless mode
- Logs in via Clerk using test credentials
- Automatically enters the CLI device code
- Clicks "Authorize Device" button
- Saves token to `~/.vm0/config.json`

## Error handling:

If tunnel fails to start:
- Check if `cloudflared` is installed
- Check tunnel logs: `tail -f /tmp/cloudflared-dev.log`

If authentication fails:
- Check dev server logs: `tail -f /tmp/nextjs-dev.log`
- Verify Clerk credentials in `turbo/apps/web/.env.local`
- Ensure Playwright browser is installed
