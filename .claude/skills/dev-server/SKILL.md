---
name: dev-server
description: Development server lifecycle management for the vm0 project
context: fork
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

Start the Turbo development server in background with stream UI mode.

**Note**: The web app now automatically starts a Cloudflare tunnel during dev startup. This means `VM0_API_URL` is set automatically and webhooks will work out of the box. The web app takes ~15 seconds longer to start than other packages due to tunnel setup.

## Workflow

### Step 1: Check if Dev Server is Already Running

First, check if dev server is already accessible by testing the port:

```bash
# Test if dev server port is open
if nc -z -w 3 localhost 3000 2>/dev/null || curl -k -s --connect-timeout 3 https://www.vm7.ai:8443/ > /dev/null 2>&1; then
  echo "✅ Dev server is already running at https://www.vm7.ai:8443"
  echo ""
  echo "To use with CLI, run /dev-auth to authenticate"
  exit 0
fi
```

If not accessible, proceed to stop any orphaned processes:

```bash
# Check and stop existing dev server processes
if pgrep -f "turbo.*dev" > /dev/null; then
  echo "⚠️ Found existing dev server process, stopping it..."
  pkill -9 -f "turbo.*dev"
  sleep 2
  echo "✅ Stopped existing dev server"
else
  echo "✅ No existing dev server process found"
fi
```

### Step 2: Generate SSL Certificates if Needed

Ensure SSL certificates exist before starting the server:

```bash
# Get project root dynamically
PROJECT_ROOT=$(git rev-parse --show-toplevel)
CERT_DIR="$PROJECT_ROOT/.certs"

# Check if all required certificates exist
if [ ! -f "$CERT_DIR/www.vm7.ai.pem" ] || \
   [ ! -f "$CERT_DIR/docs.vm7.ai.pem" ] || \
   [ ! -f "$CERT_DIR/vm7.ai.pem" ]; then
  echo "📜 Generating SSL certificates..."
  bash "$PROJECT_ROOT/scripts/generate-certs.sh"
else
  echo "✅ SSL certificates already exist"
fi
```

### Step 3: Start Dev Server in Background

Start the server with non-interactive output using Bash tool with `run_in_background: true` parameter.

**If `--tunnel-hostname=<fqdn>` was provided in args**, pass it as `TUNNEL_HOSTNAME` env var:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && TUNNEL_HOSTNAME=<fqdn> pnpm dev --ui=stream
```

**Otherwise** (default):

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm dev --ui=stream
```

This will return a shell_id (task_id) for monitoring.

### Step 4: Persist Shell ID

Save the shell_id to a file for later use:

```bash
echo "<shell_id>" > /tmp/dev-server-shell-id
```

Also save the output file path:

```bash
echo "/tmp/claude/-workspaces-vm01/tasks/<shell_id>.output" > /tmp/dev-server-output-file
```

### Step 5: Wait for Startup and Confirm

Wait a few seconds, then read the dev server logs. Look for the **Caddy proxy** output lines to determine the correct URLs. Ignore any tunnel URLs (e.g., `tunnel-*.vm7.ai`). The correct URLs are the ones reported by the Caddy proxy:

- **Web**: `https://www.vm7.ai:8443`
- **Docs**: `https://docs.vm7.ai:8443`
- **Platform**: `https://platform.vm7.ai:8443`

These `vm7.ai` domains are mapped to `127.0.0.1` locally.

Display the shell ID and URLs:

```
✅ Dev server started in background (shell_id: <id>)

- Web:      https://www.vm7.ai:8443
- Platform: https://platform.vm7.ai:8443
- Docs:     https://docs.vm7.ai:8443

Next steps:
- Use `/dev-logs` to view server output
- Use `/dev-logs [pattern]` to filter logs (e.g., `/dev-logs error`)
- Use `/dev-stop` to stop the server
```

## Notes

- The `--ui=stream` flag ensures non-interactive output suitable for background monitoring
- This operation uses context fork for isolation - the main conversation won't be polluted by server startup logs
- Tool access is restricted to: Bash, KillShell, TaskOutput only

---

# Operation: stop

Stop the background development server gracefully.

## Workflow

### Step 1: Find the Dev Server Shell ID

Read the saved shell_id from persistent storage:

```bash
if [ -f /tmp/dev-server-shell-id ]; then
  SHELL_ID=$(cat /tmp/dev-server-shell-id)
  echo "Found shell_id: $SHELL_ID"
else
  echo "No shell_id file found"
fi
```

### Step 2: Stop the Server

**If shell_id was found**, use KillShell tool:

```javascript
KillShell({ shell_id: "<shell-id>" })
```

**If shell_id not found**, try force kill:

```bash
pkill -9 -f "turbo.*dev"
```

### Step 3: Clean Up Persistent Files

Remove the shell_id files:

```bash
rm -f /tmp/dev-server-shell-id
rm -f /tmp/dev-server-output-file
```

### Step 4: Verify Stopped

Check if process still exists:

```bash
pgrep -f "turbo.*dev"
```

### Step 5: Show Results

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

```typescript
await Skill({ skill: "dev-logs", args: "<pattern>" });
```

---

# Operation: auth

Authenticate with local development server and get CLI token.

## Prerequisites

- Dev server must be running (use `/dev-start` first)
- Clerk test credentials must be configured in environment

## Workflow

### Step 1: Check Dev Server Running

First, check if dev server is accessible by testing the port:

```bash
# Test if dev server port is open
if nc -z -w 3 localhost 3000 2>/dev/null || curl -k -s --connect-timeout 3 https://www.vm7.ai:8443/ > /dev/null 2>&1; then
  echo "✅ Dev server is accessible at https://www.vm7.ai:8443"
else
  echo "❌ Dev server is not accessible"
  echo "Please run /dev-start first or check if server is running"
  exit 1
fi
```

Optionally, if you want to check logs from background server, read shell_id:

```bash
if [ -f /tmp/dev-server-shell-id ]; then
  SHELL_ID=$(cat /tmp/dev-server-shell-id)
  echo "Found background server with shell_id: $SHELL_ID"
fi
```

If shell_id exists, you can use TaskOutput to check logs:

```javascript
TaskOutput({
  task_id: "<shell-id>",
  block: false,
  timeout: 5000
})
```

But the key indicator is **HTTP endpoint accessibility**, not just the shell_id.

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

Check dev server logs to see if CLI build was successful.

First, get the shell_id:
```bash
SHELL_ID=$(cat /tmp/dev-server-shell-id)
```

Then use TaskOutput to check CLI build status:
```javascript
TaskOutput({
  task_id: "<shell-id>",
  block: false,
  timeout: 5000
})
```

Look for these indicators:
- "@vm0/cli:dev:" messages
- "Build success" or "ESM Build success" in CLI logs
- No build errors or failures

**If CLI build succeeded in dev mode**:
```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm link --global
```

**If CLI build failed or not found in logs**:
```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm build && pnpm link --global
```

### Step 4: Run Authentication Automation

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT" && npx tsx e2e/cli-auth-automation.ts http://localhost:3000
```

This script:
- Spawns `vm0 auth login` with `VM0_API_URL=http://localhost:3000`
- Launches Playwright browser in headless mode
- Logs in via Clerk using `e2e+clerk_test@vm0.ai`
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

### Step 3: Start Dev Server

Use Bash tool with `run_in_background: true`:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm dev --ui=stream
```

This will return a shell_id for monitoring. The web app will automatically start a Cloudflare tunnel.

### Step 4: Persist Shell ID

Save the shell_id to a file for later use:

```bash
echo "<shell_id>" > /tmp/dev-server-shell-id
```

### Step 5: Wait for Tunnel URL

Monitor background shell output using TaskOutput until you see:
- `[tunnel] Tunnel URL:` followed by the URL
- `Ready in` (Next.js ready message)

```javascript
TaskOutput({
  task_id: "<shell-id>",
  block: false,
  timeout: 60000
})
```

Extract the tunnel URL from output (format: `https://*.trycloudflare.com`).

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
npx tsx cli-auth-automation.ts http://localhost:3000
```

### Step 11: Verify Authentication

```bash
cat ~/.vm0/config.json
```

### Step 12: Display Results

```
✅ Dev server with tunnel started!

Local:   http://localhost:3000
Tunnel:  <tunnel-url>

VM0_API_URL exported to: <tunnel-url>

✅ CLI authentication successful!
Auth token saved to: ~/.vm0/config.json

You can now test webhooks locally:
  vm0 run <agent-name> "<prompt>"

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

