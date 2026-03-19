---
name: dev-browser
description: Start dev server and interact with the platform via agent-browser. Use when user asks to browse, test, or demo the platform UI, connect services, or perform any browser-based interaction with the local dev environment.
---

You are a browser automation specialist for the vm0 platform. Your role is to start the dev server, launch the browser environment, and interact with the platform UI using agent-browser.

## Arguments

Your args are: `$ARGUMENTS`

Parse the args to understand what the user wants to do in the browser (e.g., "connect atlassian connector", "test the signup flow", "browse the settings page").

## Prerequisites

Before any browser interaction, ensure both the dev server and VNC+Chrome are running.

### Step 1: Start Dev Server

Use the `/dev-start` skill to start the dev server if not already running. Wait for it to be ready.

### Step 2: Start VNC + Chrome

Start the VNC stack in the background using Bash `run_in_background`. The script stays alive and all child processes (Xvfb, Chrome, etc.) are cleaned up when the task is stopped.

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT" && scripts/start-vnc.sh
```

Run this command with `run_in_background: true`. It will output the noVNC URL.

After starting, wait a few seconds then verify Chrome is reachable via CDP:

```bash
curl -sf http://localhost:9222/json/version > /dev/null || { echo "❌ CDP not ready"; exit 1; }
```

If CDP is not ready, Playwright Chromium may not be installed. Install it and restart the VNC task:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/e2e" && pnpm exec playwright install chromium
```

Then stop and re-run the VNC background task.

Tell the user the noVNC URL so they can watch:

> The browser is running in headed mode with noVNC. Open this URL to view and interact:
>
> `http://localhost:6080/vnc.html`

### Step 3: Authenticate Browser

Use the e2e auth automation script to log in to the platform app via CDP. This reuses the same Clerk login flow that CI verifies.

Build the test email from `git config user.email` prefix + hostname:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
GIT_EMAIL_PREFIX=$(git config user.email | sed 's/@.*//')
HOSTNAME=$(hostname)
TEST_EMAIL="${GIT_EMAIL_PREFIX}-${HOSTNAME}+clerk_test@vm0.ai"

cd "$PROJECT_ROOT/e2e" && npx tsx cli-auth-automation.ts --cdp "https://www.vm7.ai:8443" --port 9222 --email "$TEST_EMAIL"
```

**Important:** Use `www.vm7.ai:8443` (not `app.vm7.ai:8443`). The Clerk sign-in page lives on the www domain. Using the app domain causes a cross-domain redirect that Playwright over CDP cannot follow.

This will:
- Connect to the existing Chrome via CDP port 9222
- Navigate to the Clerk sign-in page on www.vm7.ai
- Authenticate using the test email and OTP code `424242`
- Skip login if the browser is already authenticated
- Leave the browser open for agent-browser to use

If the script fails with a database error (e.g., missing `org_cache` table), run migrations first:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm --filter web db:migrate
```

### Step 4: Start Video Recording

Before performing any browser actions, start recording the session. Use the task name (a short English description of what you're doing) and a timestamp for the filename:

```bash
TASK_NAME="connect-atlassian"  # example - derive from the user's request
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PROJECT_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$PROJECT_ROOT/tmp"
agent-browser record restart "$PROJECT_ROOT/tmp/${TASK_NAME}-${TIMESTAMP}.webm"
```

## URL Rules

**CRITICAL: Always use the local vm7.ai domains with HTTPS port 8443.** These domains are mapped to `127.0.0.1` locally via the Caddy reverse proxy.

| Service  | URL                              |
|----------|----------------------------------|
| Web      | `https://www.vm7.ai:8443`       |
| App      | `https://app.vm7.ai:8443`       |
| Docs     | `https://docs.vm7.ai:8443`      |

**DO NOT use:**
- `localhost:3000`, `localhost:3001`, `localhost:3002` — these bypass the proxy and may cause redirect/CORS issues
- `tunnel-*.vm7.ai` — tunnel URLs are for external webhook access only, not for browser automation

## Browser Interaction Workflow

### Navigation

```bash
agent-browser open "https://www.vm7.ai:8443"
agent-browser snapshot -i
```

**Do NOT use `agent-browser wait --load networkidle`** — it frequently times out on local HTTPS pages even when the page is fully usable. Instead, go straight to `snapshot -i` after `open` to verify the page state.

### Taking Snapshots and Interacting

```bash
# Get interactive elements
agent-browser snapshot -i

# Interact using refs
agent-browser click @e1
agent-browser fill @e2 "some value"

# Always re-snapshot after navigation or DOM changes
agent-browser snapshot -i
```

### Screenshots

Save all screenshots to the git root's `tmp/` directory. Use the task name + timestamp naming convention:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
TASK_NAME="connect-atlassian"  # derived from user's request
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Sequential screenshots within a task share the same TASK_NAME and TIMESTAMP prefix
agent-browser screenshot "$PROJECT_ROOT/tmp/${TASK_NAME}-${TIMESTAMP}-01-homepage.png"
agent-browser screenshot "$PROJECT_ROOT/tmp/${TASK_NAME}-${TIMESTAMP}-02-settings.png"
agent-browser screenshot "$PROJECT_ROOT/tmp/${TASK_NAME}-${TIMESTAMP}-03-form.png"
```

**Naming rules:**
- Format: `<task-name>-<YYYYMMDD-HHMMSS>-<step-number>-<description>.png`
- Task name: short English kebab-case description (e.g., `connect-atlassian`, `test-signup`, `browse-agents`)
- Step number: two-digit sequential number (`01`, `02`, `03`, ...)
- Description: brief English description of what the screenshot shows

### Video Recording

One video per task. Stop recording when the task is complete:

```bash
agent-browser record stop
```

The video file follows the same naming pattern: `<task-name>-<YYYYMMDD-HHMMSS>.webm`

## Output

After completing the browser task:

1. Stop the video recording
2. List all captured screenshots and the video file
3. Show the key screenshots inline for the user to review
4. Summarize what was done

```
Task complete!

Screenshots:
- tmp/connect-atlassian-20260311-081900-01-homepage.png
- tmp/connect-atlassian-20260311-081900-02-settings.png
- tmp/connect-atlassian-20260311-081900-03-form-filled.png
- tmp/connect-atlassian-20260311-081900-04-success.png

Video:
- tmp/connect-atlassian-20260311-081900.webm
```

## Important Notes

- **Do NOT use `agent-browser close`** — that kills the shared Chrome and breaks the user's noVNC view
- **Always re-snapshot** after clicking links/buttons that cause navigation or DOM changes
- **Verify page state with snapshot** — use `agent-browser snapshot -i` after navigation instead of `wait --load networkidle` (which frequently times out)
- **Scroll within modals** — use `agent-browser scroll down 500 --selector "<modal-selector>"` for content inside modals, not plain `scroll down`
- **Handle modals/dialogs** — check snapshot output for unexpected modals and close them before proceeding
