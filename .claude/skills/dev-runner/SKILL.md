---
name: dev-runner
description: Deploy runner to metal host for local development. Use when user needs to run agents (CLI, frontend sessions, scheduled jobs) with local dev server.
---

You are a runner deployment specialist for the vm0 project. Your role is to deploy, remove, and check the status of the dev runner on a metal host.

## Operations

Your args are: `$ARGUMENTS`

Parse the args above to determine which operation to perform:

- **deploy** (default, when args are empty): Build current Rust code and deploy runner to metal host
- **remove**: Stop and uninstall the runner from metal host
- **status**: Check if the runner service is running on metal host

---

# Operation: deploy

Cross-compile the runner from current Rust code, deploy to metal host, build rootfs/snapshots for all profiles, and start the service. This connects the runner to your local web server's Cloudflare tunnel.

**This takes several minutes** (cross-compile + SSH upload + rootfs/snapshot build).

## Prerequisites

Requires `scripts/.env.local` with:
- `RUNNER_LOCAL_HOST` — metal host address
- `RUNNER_LOCAL_USER` — SSH user (default: ubuntu)
- `RUNNER_DEFAULT_GROUP` — runner group name (e.g., `vm0/local-alice-macbook`)
- `OFFICIAL_RUNNER_SECRET` — runner auth token
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — Cloudflare Access credentials

And SSH key at `.certs/vm0-metal-local.pem`.

If any of these are missing, ask the user to run `scripts/sync-env.sh`.

## Workflow

### Step 1: Verify Prerequisites

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
ENV_FILE="$PROJECT_ROOT/scripts/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ scripts/.env.local not found. Run: scripts/sync-env.sh"
  exit 1
fi

source "$ENV_FILE"
echo "RUNNER_LOCAL_HOST=${RUNNER_LOCAL_HOST:-❌ not set}"
echo "RUNNER_DEFAULT_GROUP=${RUNNER_DEFAULT_GROUP:-❌ not set}"
echo "OFFICIAL_RUNNER_SECRET=${OFFICIAL_RUNNER_SECRET:+✅ set}"
echo "CF_ACCESS_CLIENT_ID=${CF_ACCESS_CLIENT_ID:+✅ set}"

SSH_KEY="$PROJECT_ROOT/.certs/vm0-metal-local.pem"
if [[ -f "$SSH_KEY" ]]; then
  echo "SSH_KEY=✅ found"
else
  echo "SSH_KEY=❌ not found at $SSH_KEY"
fi
```

If any prerequisite is missing, tell the user to run `scripts/sync-env.sh` and stop.

### Step 2: Deploy Runner in Background

Run the deploy command with `run_in_background: true` since it takes several minutes:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm runner
```

### Step 3: Display Status

```
🔧 Runner deployment started in background (takes several minutes)

Steps in progress:
1. Cross-compile runner binary (aarch64-unknown-linux-musl)
2. Upload to metal host via SSH
3. Build rootfs + snapshot for all profiles (vm0/default)
4. Start runner service

Use `/dev-logs` pattern to monitor. You'll be notified when it completes.
The runner will connect to your local web server's tunnel automatically.
```

### Step 4: Report Completion

When the background task finishes, report success or failure. On success:

```
✅ Runner deployed!

The runner is now connected to your local web server.
You can run: vm0 run <agent-name> "<prompt>"
```

---

# Operation: remove

Stop and uninstall the runner from the metal host.

## Workflow

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT/turbo" && pnpm runner:remove
```

On success:
```
✅ Runner removed from metal host.
```

---

# Operation: status

Check if the runner service is running on the metal host.

## Workflow

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
source "$PROJECT_ROOT/scripts/.env.local"

RUNNER_GROUP="${RUNNER_DEFAULT_GROUP:?}"
RUNNER_NAME="${RUNNER_GROUP##*/}"
RUNNER_BIN="sudo /var/lib/vm0-runner/bin/${RUNNER_NAME}/runner"

"$PROJECT_ROOT/scripts/cf-ssh.sh" "$RUNNER_LOCAL_HOST" \
  -l "${RUNNER_LOCAL_USER:-ubuntu}" \
  -i "$PROJECT_ROOT/.certs/vm0-metal-local.pem" \
  "$RUNNER_BIN service status --name $RUNNER_NAME 2>/dev/null; $RUNNER_BIN doctor 2>/dev/null || true"
```

Display the service status and doctor output.
