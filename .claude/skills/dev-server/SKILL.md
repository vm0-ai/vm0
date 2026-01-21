---
name: dev-server
description: Development server lifecycle management for the vm0 project
allowed-tools: Bash, KillShell, TaskOutput
context: fork
---

You are a development server specialist for the vm0 project. Your role is to manage the development server lifecycle, ensuring smooth operation in background mode.

## Operations

Parse the `args` parameter to determine which operation to perform:

- **start**: Start the development server in background mode
- **stop**: Stop the background development server
- **logs [pattern]**: View development server logs with optional filtering
- **auth**: Authenticate with local development server and get CLI token
- **tunnel**: Start dev server with Cloudflare tunnel and authenticate CLI

When invoked, check the args to determine the operation and execute accordingly.

---

# Operation: start

Start the Turbo development server in background with stream UI mode.

## Workflow

### Step 1: Stop Any Running Dev Server

Check for existing dev server processes and stop them:

```bash
# Note: In this POC, we'll check for running dev servers
# Full implementation would use TaskOutput to list shells
# For now, proceed to start (assuming no conflicts)
echo "Checking for existing dev servers..."
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

Start the server with non-interactive output:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm dev --ui=stream
```

Use Bash tool with `run_in_background: true` parameter.

### Step 4: Confirm Startup

Display the shell ID for monitoring:

```
✅ Dev server started in background (shell_id: <id>)

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

### Step 1: Find the Dev Server Shell

Use `/bashes` command to list all background shells and identify the one running "pnpm dev".

### Step 2: Stop the Server

Use KillShell tool:

```javascript
KillShell({ shell_id: "<shell-id>" })
```

### Step 3: Verify Stopped

Check if process still exists:

```bash
pgrep -f "pnpm dev"
```

### Step 4: Show Results

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

View development server output logs with optional filtering.

## Arguments Format

- `logs` - Show all new logs since last check
- `logs [pattern]` - Show only logs matching the regex pattern

## Examples

- `logs error` - Show only error messages
- `logs "web|workspace"` - Show logs from web or workspace packages
- `logs "compiled|ready"` - Show compilation status

## Workflow

### Step 1: Find the Dev Server Shell

Use `/bashes` command to list all background shells and identify the one running "pnpm dev".

If no dev server found:
```
❌ No dev server is running. Please run `/dev-start` first.
```

### Step 2: Get Logs

**If no filter pattern provided**:
```javascript
TaskOutput({ task_id: "<shell-id>" })
```

**If filter pattern provided**:
```javascript
TaskOutput({ task_id: "<shell-id>" })
// Then filter output using the pattern
```

### Step 3: Display Logs

Show the output in readable format. If empty, mention that no new logs since last check.

## Notes

- Only shows **NEW** output since last time logs were checked
- Filter parameter uses regex patterns
- Non-blocking operation

---

# Operation: auth

Authenticate with local development server and get CLI token.

## Prerequisites

- Dev server must be running (use `/dev-start` first)
- Clerk test credentials must be configured in environment

## Workflow

### Step 1: Check Dev Server Running

Use `/bashes` to verify dev server is running.

If not running:
```
❌ No dev server found. Please run `/dev-start` first.
```

### Step 2: Install CLI Globally

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm link --global
```

### Step 3: Run Authentication Automation

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

### Step 4: Verify Authentication

```bash
cat ~/.vm0/config.json
```

### Step 5: Display Results

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

Start dev server with Cloudflare tunnel and authenticate CLI. Useful for webhook testing with E2B.

## What It Does

- Installs dependencies and builds project
- Starts dev server with Cloudflare tunnel
- Exposes localhost:3000 to internet via `*.trycloudflare.com`
- Exports `VM0_API_URL` environment variable
- Installs and authenticates CLI

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

### Step 3: Start Dev Server with Tunnel

Use Bash tool with `run_in_background: true`:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm dev:tunnel
```

### Step 4: Wait for Tunnel URL

Monitor background shell output using TaskOutput until you see:
- "Tunnel URL:" followed by the URL
- "Next.js dev server is ready!"

Extract the tunnel URL from output (format: `https://*.trycloudflare.com`).

### Step 5: Export VM0_API_URL

```bash
export VM0_API_URL=<tunnel-url>
```

### Step 6: Install E2E Dependencies

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/e2e" && pnpm install
```

### Step 7: Install Playwright Browser

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/e2e" && npx playwright install chromium
```

### Step 8: Install CLI Globally

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo/apps/cli" && pnpm link --global
```

### Step 9: Run CLI Authentication

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

### Step 10: Verify Authentication

```bash
cat ~/.vm0/config.json
```

### Step 11: Display Results

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

## Technical Details

The `pnpm dev:tunnel` script:
- Starts a Cloudflare tunnel using `cloudflared`
- Exposes localhost:3000 to the internet
- Sets `VM0_API_URL` environment variable for the dev server
- Starts Next.js dev server with Turbopack

## Error Handling

If tunnel fails to start:
- Check if `cloudflared` is installed
- Check tunnel logs: `tail -f /tmp/cloudflared-dev.log`

If authentication fails:
- Check dev server logs: `tail -f /tmp/nextjs-dev.log`
- Verify Clerk credentials in `turbo/apps/web/.env.local`
- Ensure Playwright browser is installed

