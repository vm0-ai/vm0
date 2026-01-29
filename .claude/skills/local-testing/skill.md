---
name: local-testing
description: Local testing setup - start dev server with mock Claude and run tests (unit tests, CLI E2E)
context: fork
---

# Local Testing Skill

This skill documents how to properly set up a local development environment for testing, including running unit tests and CLI E2E tests with mock Claude.

## Quick Start

### Unit Tests Only

```bash
# 1. Install dependencies
cd turbo && pnpm install

# 2. Build Rust binary (required for runner tests)
cd ../crates && cargo build

# 3. Run unit tests
cd ../turbo && pnpm vitest run
```

### CLI E2E Tests

```bash
# 1. Start dev server with tunnel (required for E2B webhooks)
/dev-start

# 2. Wait for server to be ready, then authenticate CLI
/dev-auth

# 3. Run CLI E2E tests
VM0_API_URL=http://localhost:3000 USE_MOCK_CLAUDE=true BATS_TEST_TIMEOUT=60 \
  ./e2e/test/libs/bats/bin/bats -T ./e2e/tests/01-serial/*.bats
```

---

## Prerequisites

### 1. Environment Variables

Ensure the following are set in `turbo/apps/web/.env.local`:

| Variable | Purpose | Required |
|----------|---------|----------|
| `USE_MOCK_CLAUDE` | Enable mock Claude for testing (set to `true`) | Yes for E2E |
| `CONCURRENT_RUN_LIMIT` | Set to `0` to disable run limits during testing | Yes for E2E |
| `SECRETS_ENCRYPTION_KEY` | Encryption key for secrets | Yes |
| `E2B_API_KEY` | E2B sandbox API key | Yes for E2E |
| `CLERK_SECRET_KEY` | Clerk authentication | Yes |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk authentication | Yes |

**If environment variables are missing**, ask the user to run the sync script:

```bash
scripts/sync-env.sh
```

> **Note**: `sync-env.sh` requires 1Password authentication and can only be executed by the user directly. If you encounter missing environment variable errors, request the user to run this script.

### 2. Add Mock Claude Configuration

```bash
# Add to turbo/apps/web/.env.local
echo "USE_MOCK_CLAUDE=true" >> turbo/apps/web/.env.local
echo "CONCURRENT_RUN_LIMIT=0" >> turbo/apps/web/.env.local
```

---

## Starting the Dev Server

### Using the Skill

```bash
/dev-start
```

This will:
- Start the Turbo dev server in background
- Automatically start a Cloudflare tunnel for the web app
- Set `VM0_API_URL` to the tunnel URL
- Enable E2B webhooks to reach your local server

### Manual Start

```bash
cd turbo && pnpm dev
```

### Verify Server is Ready

Check for these indicators in the logs (`/dev-logs`):
- `[tunnel] Tunnel URL: https://xxx.trycloudflare.com`
- `Ready in XXXms` for each app
- No fatal errors

**Important**: The tunnel URL changes each time you restart. E2B sandbox webhooks use this URL to send events back to your local server.

---

## Running Unit Tests

### Prerequisites

Before running unit tests, ensure dependencies are installed and Rust binary is built:

```bash
# 1. Install Node.js dependencies
cd turbo && pnpm install

# 2. Build Rust vsock-agent binary (required for runner tests)
cd ../crates && cargo build
```

### Run All Tests

```bash
cd turbo && pnpm vitest run
```

Expected output:
```
Test Files  173 passed (173)
Tests       2348 passed (2348)
```

### Run Tests in Watch Mode

```bash
cd turbo && pnpm vitest
```

### Run Specific Test File

```bash
cd turbo && pnpm vitest run apps/web/src/lib/__tests__/my-test.test.ts
```

### Run Tests for a Specific Package

```bash
cd turbo && pnpm vitest run --project @vm0/cli
cd turbo && pnpm vitest run --project web
cd turbo && pnpm vitest run --project @vm0/runner
```

---

## Running CLI E2E Tests

### Test Structure

```
e2e/tests/
├── 01-serial/              # Tests that MUST run serially (scope setup)
├── 02-parallel/            # Tests that CAN run in parallel
└── 03-experimental-runner/ # Runner-specific tests (needs runner deployed)
```

### Environment Variables for E2E

| Variable | Value | Purpose |
|----------|-------|---------|
| `VM0_API_URL` | `http://localhost:3000` | API endpoint |
| `USE_MOCK_CLAUDE` | `true` | Use mock Claude instead of real API |
| `BATS_TEST_TIMEOUT` | `30` (serial) / `60` (parallel) | Per-test timeout in seconds |

### Running Serial Tests

```bash
VM0_API_URL=http://localhost:3000 \
USE_MOCK_CLAUDE=true \
BATS_TEST_TIMEOUT=30 \
./e2e/test/libs/bats/bin/bats -T ./e2e/tests/01-serial/*.bats
```

### Running Parallel Tests

```bash
VM0_API_URL=http://localhost:3000 \
USE_MOCK_CLAUDE=true \
BATS_TEST_TIMEOUT=60 \
./e2e/test/libs/bats/bin/bats -T -j 10 --no-parallelize-within-files ./e2e/tests/02-parallel/*.bats
```

### Running a Single Test File

```bash
VM0_API_URL=http://localhost:3000 \
USE_MOCK_CLAUDE=true \
BATS_TEST_TIMEOUT=60 \
./e2e/test/libs/bats/bin/bats -T ./e2e/tests/02-parallel/t17-vm0-simplified-compose.bats
```

### Running a Specific Test by Name

```bash
VM0_API_URL=http://localhost:3000 \
USE_MOCK_CLAUDE=true \
BATS_TEST_TIMEOUT=60 \
./e2e/test/libs/bats/bin/bats -T ./e2e/tests/02-parallel/t17-vm0-simplified-compose.bats \
  --filter "vm0 compose with both instructions and skills"
```

---

## How Mock Claude Works

When `USE_MOCK_CLAUDE=true`:

1. The web server passes this to E2B sandbox via environment variable
2. Inside sandbox, `run-agent.ts` checks for `USE_MOCK_CLAUDE`
3. Instead of running real `claude` CLI, it runs `/usr/local/bin/vm0-agent/mock-claude.mjs`
4. Mock Claude executes the prompt as a bash command and outputs Claude-compatible JSONL

Mock Claude location: `turbo/packages/core/src/sandbox/scripts/src/mock-claude.ts`

---

## Troubleshooting

### Unit Test Issues

#### Problem: "@radix-ui/react-select could not be resolved" or Missing Dependencies

**Cause**: Dependencies not installed or out of sync

**Solution**:
```bash
cd turbo && pnpm install
```

#### Problem: "Agent binary not found: vsock-agent"

**Cause**: Rust binary not compiled

**Solution**:
```bash
cd crates && cargo build
```

#### Problem: Tests Fail After Pulling New Changes

**Solution**:
```bash
# Reinstall dependencies and rebuild
cd turbo && pnpm install
cd ../crates && cargo build
cd ../turbo && pnpm vitest run
```

---

### CLI E2E Test Issues

### Problem: "Failed to fetch events" or Run Hangs

**Cause**: E2B sandbox cannot reach the tunnel URL (webhooks fail)

**Solution**:
1. Check if tunnel is active: `/dev-logs tunnel`
2. Test tunnel connectivity:
   ```bash
   curl -v https://<tunnel-url>/api/webhooks/agent/events
   ```
3. If SSL errors occur, restart dev server to get a fresh tunnel:
   ```bash
   /dev-stop
   /dev-start
   ```

### Problem: "Concurrent agent run limit" Error

**Cause**: `CONCURRENT_RUN_LIMIT` not set or not 0

**Solution**:
```bash
echo "CONCURRENT_RUN_LIMIT=0" >> turbo/apps/web/.env.local
# Then restart dev server
```

### Problem: Tests Timeout

**Cause**: `vm0 run` takes ~15-30 seconds per execution

**Solution**:
- Ensure `BATS_TEST_TIMEOUT` is set appropriately (60s for parallel tests)
- Check server logs for errors: `/dev-logs error`
- Verify E2B sandbox is starting: `/dev-logs sandbox`

### Problem: "SECRETS_ENCRYPTION_KEY" Missing or Other Environment Variables Missing

**Cause**: Environment variables not synced from 1Password

**Solution**: Ask the user to run the sync script (requires 1Password authentication):
```bash
scripts/sync-env.sh
```

> **Note**: This script can only be executed by the user directly as it requires interactive 1Password authentication.

### Problem: SSL Certificate Errors (e.g., "platform.vm7.ai.pem - MISSING")

**Cause**: SSL certificates not generated for local development

**Solution**:
```bash
scripts/generate-certs.sh
```

### Problem: "parallel: command not found" When Running Parallel E2E Tests

**Cause**: GNU Parallel not installed

**Solution**:
```bash
sudo apt-get install -y parallel
```

### Problem: Port Already in Use

**Solution**:
```bash
# Kill processes on dev ports
fuser -k 3000/tcp 3001/tcp 3002/tcp 3003/tcp

# Or use dev-stop
/dev-stop
```

### Problem: "SyntaxError: Unexpected end of JSON input" During Parallel Tests

**Cause**: High concurrency causing request body truncation (local dev environment limitation)

**Solution**:
- This is a transient issue in local dev, CI environment doesn't have this problem
- Run fewer parallel jobs: `-j 4` instead of `-j 10`
- Or run tests individually to verify they pass

---

## CI vs Local Differences

| Aspect | CI | Local |
|--------|-----|-------|
| Server | Vercel Preview | localhost + tunnel |
| Tunnel | Not needed | Cloudflare tunnel required |
| Concurrency | High | May have issues with -j 10 |
| Timeouts | 8 min total | No global limit |

---

## Useful Commands

```bash
# Check dev server status
/dev-logs

# Filter logs by pattern
/dev-logs error
/dev-logs tunnel
/dev-logs sandbox

# Stop dev server
/dev-stop

# Authenticate CLI with local server
/dev-auth

# Check CLI auth status
vm0 auth status

# Manual test of vm0 run with mock Claude
vm0 run <agent-name> --artifact-name <artifact> "echo hello"
```

---

## Reference

- CLI E2E Testing Patterns: `.claude/skills/cli-e2e-testing/skill.md`
- Dev Server Management: `.claude/skills/dev-server/skill.md`
- Mock Claude Source: `turbo/packages/core/src/sandbox/scripts/src/mock-claude.ts`
- E2B Executor: `turbo/apps/web/src/lib/run/executors/e2b-executor.ts`
