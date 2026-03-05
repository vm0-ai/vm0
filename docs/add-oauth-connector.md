## Add OAuth Connector Checklist

1. Use existing OAuth connectors (e.g., Gmail, Notion, Linear) as templates for implementation.
1. Ensure you use the real product SVG logo from the Internet, not a placeholder image.
1. Ensure the new connector is protected with a feature switch, and that the feature switch is disabled by default.
1. Add the OAuth env vars to both `.github/workflows/turbo.yml` and `.github/workflows/release-please.yml` deploy steps (client ID from `vars`, client secret from `secrets`).
1. Ensure that `.env.tpl` references the correct secrets/vars and that the secret/var names in 1Password match the environment variable names.
1. Ask the user to fill in the OAuth credentials (client ID and client secret) in 1Password (both Development and Production vaults), then run `bash scripts/sync-oauth.sh PROVIDER_NAME` to sync credentials from 1Password to GitHub vars/secrets. Wait for the user to confirm completion.
1. Verify that the secrets/vars are correctly set on GitHub by running `gh variable list | grep PROVIDER` and `gh secret list | grep PROVIDER`.
1. Make sure the local `.env.local` contains the correct secret/var values.
1. Start the project locally with `pnpm dev` and verify that it can successfully connect to the OAuth provider and obtain user information. Use `agent-browser` to complete the OAuth flow:

   **Prerequisites:** The user must have Chrome running on macOS with remote debugging enabled:
   ```bash
   # macOS (user runs this once)
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir=$HOME/.local/agent-browser \
     --remote-allow-origins='*'
   ```

   **Connect and sign in:**
   ```bash
   # Discover the CDP WebSocket URL (use IP to bypass Host header check)
   CDP_URL=$(curl -s http://0.250.250.254:9222/json/version | python3 -c "import sys,json; print(json.load(sys.stdin)['webSocketDebuggerUrl'])")
   agent-browser --cdp "$CDP_URL" open "https://platform.vm7.ai:8443/sign-in"
   agent-browser wait 3000 && agent-browser snapshot -i

   # Sign up (first time) or sign in with Clerk test credentials
   # Use any email containing +clerk_test (e.g., test+clerk_test@example.com)
   agent-browser fill @<email-ref> "test+clerk_test@example.com"
   agent-browser fill @<password-ref> "<unique-password>"
   agent-browser click @<continue-ref>
   agent-browser wait 5000 && agent-browser snapshot -i

   # Enter Clerk test verification code
   agent-browser fill @<code-ref> "424242"
   agent-browser wait 5000 && agent-browser snapshot -i
   ```

   **Connect the OAuth provider:**
   ```bash
   # Navigate to connections settings
   agent-browser open "https://platform.vm7.ai:8443/settings?tab=connections"
   agent-browser wait 3000 && agent-browser snapshot -i

   # Click "Connect" on the target provider — this opens the provider's OAuth login page
   agent-browser click @<connect-button-ref>
   agent-browser wait 5000 && agent-browser snapshot -i
   ```

   > **Important:** After clicking "Connect", the OAuth provider's login page requires the user's real account credentials. **Stop here and ask the user to complete the OAuth authorization in the browser manually.** Once the user confirms the OAuth flow is complete, continue with `agent-browser snapshot -i` to verify the connector status.

   > **Note:** Refs (`@e1`, `@e2`, etc.) are dynamic — always run `snapshot -i` to get fresh refs before interacting.

## Skill Validation Loop

After the connector is verified locally, iterate on the skill and connector code until all API examples pass. This is a loop between AI-driven testing and human-assisted OAuth reconnection.

### Step 1: Create or update the skill [AI]

**Before writing or modifying a skill, read all docs in `vm0-ai/vm0-skills/docs/`** — especially `skill-template.md` (authoring guide) and `bad-smell.md` (anti-patterns to avoid). Key rules:

- Use `<placeholder>` (e.g., `<file-key>`, `<project-id>`) for dynamic URL parameters — NOT shell variables like `$FILE_KEY`.
- Use `-d @/tmp/request.json` for JSON request bodies — NOT inline JSON with `-d '{"key": "value"}'`.
- Use `--header` instead of `-H`.
- Wrap commands containing `$VAR` in `bash -c '...'` and keep `jq` outside the wrapper.

Check the `vm0-ai/vm0-skills` repository for a related skill.

- If one exists, ensure the skill's `vm0_secrets` matches the environment variable key from the connector's `environmentMapping` (e.g., connector maps `X_TOKEN: "$secrets.X_ACCESS_TOKEN"` → skill declares `vm0_secrets: [X_TOKEN]`).
- If it does not match, modify the skill and push to main of the skill repository.
- If no skill exists, create one by studying the provider's API docs, then push to main. Cover the main capabilities of the connector (CRUD operations, list endpoints, etc.) with concrete curl examples.

### Step 2: Run `vm0 cook` [AI]

Create a test directory and run the skill end-to-end:

```bash
mkdir test-<connector-name>-connector && cd test-<connector-name>-connector
```

vm0.yaml

```yaml
version: "1.0"

agents:
  agent:
    framework: claude-code
    instructions: AGENTS.md
    skills:
      - <skill-name>
```

AGENTS.md (empty content)

```text

```

Then run:

```bash
vm0 cook --yes "test every example in skill <skill-name>"
```

> **Note:** The `--yes` flag is required to auto-approve new secrets detected from the skill. Without it, compose will fail in non-interactive mode.

### Step 3: Review results and fix [AI]

Review the test results. The agent will execute every curl example from the skill and report which ones succeed or fail.

**Common issues and fixes (all AI-driven):**

- **Wrong response field names in jq filters:** The skill guessed field names that don't match the actual API response. Fix the jq expressions in the skill and push to main.
- **Wrong date/time format:** Some APIs require datetime (`2025-02-01T09:00:00`) instead of date-only (`2025-02-01`). Fix the example and add a guideline note.
- **Token response parsing errors:** The connector code may expect a different response structure than what the provider returns (e.g., `athlete_id` at top level vs nested `athlete.id`). Fix the connector code.
- **Variable not injected:** Ensure `vm0_secrets` in the skill matches the key (not the value) of the connector's `environmentMapping`.

**Issues that require human intervention:**

- **Missing OAuth scopes (401/403):** The connector requested insufficient scopes. Fix the scopes in the connector code, then reconnect using `agent-browser`:
  ```bash
  # Navigate to connections settings
  agent-browser open "https://platform.vm7.ai:8443/settings?tab=connections"
  agent-browser wait 3000 && agent-browser snapshot -i

  # Disconnect the existing connector
  agent-browser click @<disconnect-button-ref>
  agent-browser wait 2000 && agent-browser snapshot -i

  # Reconnect — click "Connect" then ask the user to complete the OAuth login manually
  agent-browser click @<connect-button-ref>
  agent-browser wait 5000 && agent-browser snapshot -i
  # Stop and ask the user to authorize in the browser, then verify with snapshot -i
  ```
- **Credits/quota depleted:** The OAuth provider's API has usage limits. The connector itself is working if at least one endpoint succeeds (e.g., `/users/me`).

### Step 4: Re-run and iterate [AI]

After fixes:

- **Skill-only changes** (jq fields, example tweaks, documentation): Push to `vm0-skills` main, re-run `vm0 cook`. No human needed.
- **Connector code changes** (response parsing, error handling): Re-run `vm0 cook`. No human needed — the dev server hot-reloads.
- **Scope changes**: Disconnect and reconnect the connector via `agent-browser` (see Step 3 scope fix above), then re-run `vm0 cook`.

Repeat Steps 2–4 until all examples pass.

### Step 5: Clean up [AI]

```bash
cd .. && rm -rf test-<connector-name>-connector
```

### Step 6: Ship [AI]

If everything works, the connector is ready to be merged. Remove the feature switch to make the connector public.
