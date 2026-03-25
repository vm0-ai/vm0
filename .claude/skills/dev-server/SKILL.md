---
name: dev-server
description: Development server lifecycle management for the vm0 project
context: main
---

You are a development server specialist for the vm0 project. Your role is to manage the development server lifecycle, ensuring smooth operation in background mode.

## Operations

Your args are: `$ARGUMENTS`

Parse the args above to determine which operation to perform:

- **start**: Start the development server in background mode (tunnel is automatic for web app). Supports `--tunnel-hostname=<fqdn>` to use a fixed tunnel domain instead of the auto-generated one.
- **stop**: Stop the background development server
- **logs [pattern]**: View development server logs with optional filtering (delegates to `dev-logs` skill)
- **auth**: Authenticate with local development server and get CLI token
- **tunnel**: Full setup with tunnel and CLI authentication

**Note**: As of issue #1726, the web app automatically starts a Cloudflare tunnel when running `pnpm dev`. The tunnel URL is displayed during startup and `VM0_API_URL` is set automatically.

---

# Operation: start

Start the Turbo development server in background mode.

**Note**: The web app now automatically starts a Cloudflare tunnel during dev startup. This means `VM0_API_URL` is set automatically and webhooks will work out of the box. The web app takes ~15 seconds longer to start than other packages due to tunnel setup.

## Workflow

### Step 1: Pre-flight Check

Run the dev server status check. This verifies SSL certificates (regenerating if missing) and checks port accessibility:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm dev:status
```

If all three services show `running`, the dev server is already up — display the output and stop. Otherwise, proceed to start the server.

### Step 2: Start Runner in Background

Start the runner first using Bash tool with `run_in_background: true` parameter. The runner takes several minutes to initialize, so we start it early to overlap with the prepare step.

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm runner
```

This returns a task_id for monitoring.

**Note on runner**: The runner takes several minutes to initialize (cross-compile, upload, build rootfs/snapshots). The app works without it — only chat/agent interaction features require the runner. You will be notified when the runner background task completes.

### Step 3: Run prepare.sh

While the runner is initializing in the background, run `prepare.sh` to set up the environment (sync .env.local, install dependencies, run database migrations). This may take a few minutes — wait for it to complete:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT" && bash -c 'set -o pipefail; bash scripts/prepare.sh 2>&1 | tee /tmp/prepare-output.log'
```

#### If prepare.sh fails

If the command above exits with a non-zero code, do the following **before** reporting the failure to the user:

1. **Gather diagnostic info** by running:

```bash
echo "HOSTNAME: $(hostname)"
echo "BRANCH: $(git branch --show-current)"
echo "--- LAST 20 LINES ---"
tail -20 /tmp/prepare-output.log
```

2. **Determine the failed step**: inspect the output for `db:migrate` or `Database migrations failed`. If found, the failed step is `db:migrate`; otherwise, report it as `prepare.sh`.

3. **Send a Slack notification** to `#flaky-test` using the Slack MCP tool (`slack_send_message`) with the following message format:

```
🔴 Dev server prepare failed on `<hostname>` (branch: `<branch>`)

**Failed step:** <prepare.sh or db:migrate>
**Error snippet:**
\`\`\`
<last ~20 lines of /tmp/prepare-output.log>
\`\`\`

> ℹ️ This may be caused by FK constraints preventing migration on databases with real data.
```

4. **Report the failure to the user** as normal — do NOT silently swallow the error, and do NOT proceed to Step 4.

#### If prepare.sh succeeds

Proceed to Step 4 as normal. No Slack notification is sent.

### Step 4: Start Dev Server in Background

After `prepare.sh` completes successfully, start the dev server using Bash tool with `run_in_background: true` parameter.

**Important**: Use `tee` to write output to a persistent log file so `/dev-logs` works even after context compaction. The log file is the primary way `/dev-logs` reads output.

If `--tunnel-hostname=<fqdn>` was provided in args, pass it as `TUNNEL_HOSTNAME` env var:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && TUNNEL_HOSTNAME=<fqdn> pnpm dev 2>&1 | tee "$PROJECT_ROOT/turbo/.dev-server.log"
```

Otherwise (default):

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm dev 2>&1 | tee "$PROJECT_ROOT/turbo/.dev-server.log"
```

**Save the dev server task_id** to a local file for TaskOutput fallback:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
echo "<dev-task_id>" > "$PROJECT_ROOT/turbo/.dev-task-id"
```

### Step 5: Display Results

Once the server is confirmed running, display the URLs:

```
✅ Dev server started in background
🔧 Runner deployment started in background (takes several minutes)

- Web:      https://www.vm7.ai:8443
- App:      https://app.vm7.ai:8443
- Docs:     https://docs.vm7.ai:8443

The app is usable now. Chat/agent features will become available once the runner finishes initializing.

Next steps:
- Use `/dev-logs` to view server output
- Use `/dev-logs [pattern]` to filter logs (e.g., `/dev-logs error`)
- Use `/dev-stop` to stop the server
```

## Notes

- Use TaskOutput with the task_id from `run_in_background` to check server output
- This operation runs in main context so the background task persists throughout the conversation
- **NEVER use `nohup` to start the server** (e.g., `nohup pnpm dev > /tmp/dev-server.log 2>&1 &`). Always use the Bash tool's `run_in_background: true` parameter instead.

---

# Operation: stop

Stop the background development server gracefully.

## Workflow

### Step 1: Stop the Server

Kill the dev server processes:

```bash
pkill -f "turbo.*dev" 2>/dev/null
pkill -f "pnpm.*dev" 2>/dev/null
```

### Step 2: Verify Stopped

Check if processes are gone and Caddy is no longer responding:

```bash
pgrep -f "turbo.*dev" || echo "✅ No turbo dev processes found"
curl -k -s --connect-timeout 3 https://www.vm7.ai:8443/ > /dev/null 2>&1 && echo "⚠️ Server still responding" || echo "✅ Server is down"
```

### Step 3: Show Results

**If stopped successfully**:
```
✅ Dev server stopped successfully

You can start it again with `/dev-start`
```

**If process still detected**:
```
⚠️ Warning: Dev server process still detected

Try manual cleanup: pkill -f "pnpm dev"
```

**If no dev server was running**:
```
ℹ️ No dev server is currently running

Use `/dev-start` to start one
```

---

# Operation: logs

Delegate to the `dev-logs` skill. Extract the optional filter pattern from args (e.g. `logs error` → pattern is `error`) and invoke:

invoke skill /dev-logs <pattern>

---

# Operation: auth

Authenticate with local development server and get CLI token.

## Prerequisites

- Dev server must be running (use `/dev-start` first)
- Clerk test credentials must be configured in environment

## Workflow

### Step 1: Check Dev Server Running

Check if dev server is accessible via the Caddy reverse proxy:

```bash
if curl -k -s --connect-timeout 3 https://www.vm7.ai:8443/ > /dev/null 2>&1; then
  echo "✅ Dev server is accessible at https://www.vm7.ai:8443"
else
  echo "❌ Dev server is not accessible"
  echo "Please run /dev-start first or check if server is running"
  exit 1
fi
```

### Step 2: Check Required Environment Variables

Check and ensure all required environment variables are set in `turbo/apps/web/.env.local`:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
ENV_FILE="$PROJECT_ROOT/turbo/apps/web/.env.local"

# Check NEXT_PUBLIC_APP_URL
if ! grep -q "^NEXT_PUBLIC_APP_URL=" "$ENV_FILE" 2>/dev/null; then
  echo "⚠️ NEXT_PUBLIC_APP_URL not found, adding it..."
  echo "NEXT_PUBLIC_APP_URL=http://localhost:3000" >> "$ENV_FILE"
  echo "✅ Added NEXT_PUBLIC_APP_URL to .env.local"
  echo "⚠️ Note: Dev server needs restart to pick up this change"
fi

# Check NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
if ! grep -q "^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=" "$ENV_FILE" 2>/dev/null; then
  echo "❌ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY not found in .env.local"
  echo "Please run: script/sync-env.sh"
  exit 1
fi

# Check CLERK_SECRET_KEY
if ! grep -q "^CLERK_SECRET_KEY=" "$ENV_FILE" 2>/dev/null; then
  echo "❌ CLERK_SECRET_KEY not found in .env.local"
  echo "Please run: script/sync-env.sh"
  exit 1
fi

echo "✅ All required environment variables are present"
```

### Step 3: Build and Install CLI Globally

Build and install the CLI globally:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm build && pnpm link --global
```

### Step 4: Run Authentication Automation

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT" && npx tsx e2e/cli-auth-automation.ts $(printenv VM0_API_URL)
```

This script:
- Spawns `vm0 auth login` with the current `VM0_API_URL`
- Launches Playwright browser in headless mode
- Logs in via Clerk using `$(hostname)+clerk_test@vm0.ai`
- Automatically enters the CLI device code
- Clicks "Authorize Device" button
- Saves token to `~/.vm0/config.json`

### Step 5: Verify Authentication

```bash
cat ~/.vm0/config.json
```

### Step 6: Display Results

```
✅ CLI authentication successful!

Auth token saved to: ~/.vm0/config.json

You can now use the CLI with local dev server:
- vm0 auth status
- vm0 project list
```

## Error Handling

If authentication fails:
- Check dev server logs with `/dev-logs`
- Verify Clerk credentials in `turbo/apps/web/.env.local`
- Ensure Playwright browser is installed

---

# Operation: tunnel

Full development environment setup with Cloudflare tunnel and CLI authentication. Useful for webhook testing.

**Note**: Since issue #1726, the web app automatically starts a Cloudflare tunnel when running `pnpm dev`. This operation is useful when you need the **complete setup** including CLI authentication.

## What It Does

- Installs dependencies and builds project
- Starts dev server (tunnel is now automatic for web app)
- Installs E2E dependencies and Playwright
- Installs and authenticates CLI globally

## Workflow

### Step 1: Install Dependencies

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm install
```

### Step 2: Build Project

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm build
```

### Step 3: Start Dev Server and Runner

Use Bash tool with `run_in_background: true` for **both** commands in parallel (two separate Bash calls in the same message):

**Dev server** (use `tee` to persist logs for `/dev-logs` after context compaction):
```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm dev 2>&1 | tee "$PROJECT_ROOT/turbo/.dev-server.log"
```

**Runner:**
```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm runner
```

Both return a task_id for monitoring. The web app will automatically start a Cloudflare tunnel. The runner takes several minutes to initialize but doesn't block the app — only chat/agent features need it.

### Step 4: Wait for Tunnel URL

Use TaskOutput with the task_id from Step 3 to monitor the background task output. Look for:
- `[tunnel] Tunnel URL:` followed by the URL
- `Ready in` (Next.js ready message)

Poll TaskOutput every few seconds until the tunnel URL appears (up to ~60 seconds). Extract the tunnel URL (format: `https://*.trycloudflare.com`).

If the tunnel URL does not appear within ~60 seconds, report the failure and let the user investigate.

### Step 6: Export VM0_API_URL

```bash
export VM0_API_URL=<tunnel-url>
```

### Step 7: Install E2E Dependencies

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/e2e" && pnpm install
```

### Step 8: Install Playwright Browser

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/e2e" && npx playwright install chromium
```

### Step 9: Install CLI Globally

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm link --global
```

### Step 10: Run CLI Authentication

Read Clerk credentials from `turbo/apps/web/.env.local`:
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` → `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY` → `CLERK_SECRET_KEY`

Then run:
```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/e2e" && \
CLERK_PUBLISHABLE_KEY=<publishable-key> \
CLERK_SECRET_KEY=<secret-key> \
npx tsx cli-auth-automation.ts $(printenv VM0_API_URL)
```

### Step 11: Verify Authentication

```bash
cat ~/.vm0/config.json
```

### Step 12: Display Results

```
✅ Dev server with tunnel started!
🔧 Runner deployment started in background (takes several minutes)

Local:   http://localhost:3000
Tunnel:  <tunnel-url>

VM0_API_URL exported to: <tunnel-url>

✅ CLI authentication successful!
Auth token saved to: ~/.vm0/config.json

The app is usable now. Chat/agent features will become available once the runner finishes initializing.

Use `/dev-stop` to stop the server.
```

## Technical Details

The web app's dev script (`turbo/apps/web/scripts/dev.sh`):
- Starts a Cloudflare tunnel using `cloudflared`
- Exposes localhost:3000 to the internet
- Sets `VM0_API_URL` environment variable
- Starts Next.js dev server with Turbopack

## Error Handling

If tunnel fails to start:
- Check if `cloudflared` is installed
- Check tunnel logs: `tail -f /tmp/cloudflared-dev.log`

If authentication fails:
- Check dev server logs with `/dev-logs`
- Verify Clerk credentials in `turbo/apps/web/.env.local`
- Ensure Playwright browser is installed

