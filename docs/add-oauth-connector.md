## OAuth App Registration

Before writing any code, register the OAuth application with the provider. The client ID and client secret generated during registration are required for implementation.

### Register Two Apps

Register two separate OAuth apps for each provider — one for development/testing and one for production:

| App | Purpose | Redirect URI |
|-----|---------|--------------|
| **VM0** (or **VM0 AI** if "VM0" is too short or already taken) | Production | `https://www.vm0.ai/api/connectors/<provider>/callback` |
| **VM0 TEST** (or **VM0 AI TEST**) | Development / testing | `https://www.vm7.ai:8443/api/connectors/<provider>/callback` |

> The app **without** TEST is the **production** app; the app **with** TEST is for **development/testing**.

### Naming Rules

- Prefer **VM0** as the app name; use **VM0 AI** if "VM0" is too short or already taken
- Append **TEST** for the production app (e.g., **VM0 TEST** or **VM0 AI TEST**)
- Slug format: lowercase, spaces replaced with hyphens — `vm0`, `vm0-test`, `vm0-ai`, `vm0-ai-test`

### Common Fields

- **Description:** Summarize from https://www.vm0.ai
- **Scopes:** Request the broadest set of scopes that make sense for an AI office-assistant use case (read, write, and organization/team-level access where applicable). Request delete scopes only when clearly necessary and appropriate. Do not blindly enable all scopes — match scopes to what the service actually does.
- **Logo:** Stop and ask the user to upload the logo manually.
- **Redirect URIs:** Use the values in the table above, replacing `<provider>` with the connector's app name (e.g., `gmail`, `notion`, `linear`).

### Registration Workflow

Use `agent-browser` to navigate the provider's developer portal, filling in each field above. Stop and ask the user to confirm before submitting any form that creates or modifies an app registration. For logo upload, always stop and let the user handle it manually.

**As you register each app**, write the credentials you see (client ID, client secret, slug) into `/tmp/oauth-credentials/<PROVIDER>` immediately — don't wait until both apps are done:

```
PROVIDER_OAUTH_SLUG=<dev/test app slug>          # optional
PROVIDER_OAUTH_CLIENT_ID=<dev/test client ID>
PROVIDER_OAUTH_CLIENT_SECRET=<dev/test client secret>
PROVIDER_OAUTH_SLUG_PROD=<prod app slug>          # optional
PROVIDER_OAUTH_CLIENT_ID_PROD=<prod client ID>
PROVIDER_OAUTH_CLIENT_SECRET_PROD=<prod client secret>
```

- Non-`_PROD` fields = **VM0 TEST** app (development/testing)
- `_PROD` fields = **VM0** app (production)

If a client secret is hidden in the UI and you can't reveal it programmatically, leave the field empty — the script will report which fields are missing.

After both apps are registered and the credentials file is populated:

1. Run `bash scripts/sync-oauth.sh PROVIDER_NAME`.
   - The script reads `/tmp/oauth-credentials/<PROVIDER>`, shows a preview, and syncs all non-empty values to 1Password and GitHub in one pass.
   - If any required fields are missing, it will list them and exit — fill them in and re-run.
2. Wait for the user to confirm the sync completed successfully before proceeding to implementation.

---

## Add OAuth Connector Checklist

1. Use existing OAuth connectors (e.g., Gmail, Notion, Linear) as templates for implementation.
1. After writing code, run lint and type checks. If you see pre-existing errors unrelated to your changes, they are almost certainly caused by a stale local environment — `main` passes CI so there are no pre-existing lint or type issues on a clean checkout. Fix the environment first:
   ```bash
   pnpm install          # sync dependencies
   pnpm -F web db:migrate  # apply pending migrations
   cd turbo && pnpm build  # generate .next types and other build artifacts
   ```
   Then re-run the checks. Only investigate errors that persist after the environment is fresh.
1. Ensure you use the real product SVG logo from the Internet, not a placeholder image.
1. Ensure the new connector is protected with a feature switch, and that the feature switch is disabled by default.
1. Add the OAuth env vars to both `.github/workflows/turbo.yml` and `.github/workflows/release-please.yml` deploy steps (client ID from `vars`, client secret from `secrets`).
1. Ensure that `.env.tpl` references the correct secrets/vars and that the secret/var names in 1Password match the environment variable names.
1. Run `bash scripts/sync-oauth.sh PROVIDER_NAME` to sync credentials from `/tmp/oauth-credentials/<PROVIDER>` to 1Password and GitHub. If any fields are missing, fill them in and re-run. Wait for the user to confirm completion.
1. Verify that the secrets/vars are correctly set on GitHub by running `gh variable list | grep PROVIDER` and `gh secret list | grep PROVIDER`.
1. Make sure the local `.env.local` contains the correct secret/var values.
1. Commit all changes and create a PR using `/pull-request`. This lets CI validate the implementation in parallel while you do local testing.
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
   agent-browser --cdp "$CDP_URL" open "https://www.vm7.ai:8443/sign-in"
   agent-browser wait 3000 && agent-browser snapshot -i

   # Sign up (first time) or sign in with Clerk test credentials
   # Use any email containing +clerk_test (e.g., test+clerk_test@example.com)
   agent-browser fill @<email-ref> "test+clerk_test@example.com"
   agent-browser fill @<password-ref> "<unique-password>"
   agent-browser click @<continue-ref>
   agent-browser wait 5000 && agent-browser snapshot -i

   # If "Password is incorrect" error appears, use email code instead:
   agent-browser click @<use-another-method-ref>
   agent-browser wait 2000 && agent-browser snapshot -i
   agent-browser click @<email-code-ref>   # click the "Email code" option
   agent-browser wait 2000 && agent-browser snapshot -i

   # Enter Clerk test verification code
   agent-browser fill @<code-ref> "424242"
   agent-browser wait 5000 && agent-browser snapshot -i
   ```

   **Connect the OAuth provider:**
   ```bash
   # Option A: Navigate to connections settings and click Connect
   agent-browser open "https://www.vm7.ai:8443/settings?tab=connections"
   agent-browser wait 3000 && agent-browser snapshot -i
   agent-browser click @<connect-button-ref>
   agent-browser wait 5000 && agent-browser snapshot -i

   # Option B: Hit the authorize endpoint directly (faster)
   agent-browser open "https://www.vm7.ai:8443/api/connectors/<connector-name>/authorize"
   agent-browser wait 5000 && agent-browser snapshot -i
   ```

   > **Important:** The OAuth flow has two distinct stages:
   > 1. **Provider login page** (if not already logged in) — requires the user's real account credentials. Stop and ask the user to log in manually, then continue.
   > 2. **Authorization/consent page** — the page asking to grant permissions to our app. This can be clicked directly with `agent-browser click @<authorize-button-ref>` without human confirmation.

   > **Note:** Refs (`@e1`, `@e2`, etc.) are dynamic — always run `snapshot -i` to get fresh refs before interacting.

   **If the callback returns an error page**, check the dev server logs and the error message in the URL. Before diving into code, **search the web for the error** — provider-specific quirks (e.g., OAuth scopes appended to the callback URL, non-standard token response shapes) are often documented in community forums or the provider's own changelog. Use `WebSearch` with the provider name and the error message to see if others have encountered the same issue.

   **If the error is "No scope found for user"**, the test user has no scope in the dev database (known bug, to be fixed). Workaround: run this fetch in the browser while logged in as the test user, then retry the OAuth flow:
   ```bash
   agent-browser eval "fetch('/api/scope', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({slug: 'test-user-scope'})}).then(r=>r.json()).then(d=>JSON.stringify(d))"
   ```

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
  agent-browser open "https://www.vm7.ai:8443/settings?tab=connections"
  agent-browser wait 3000 && agent-browser snapshot -i

  # Disconnect the existing connector
  agent-browser click @<disconnect-button-ref>
  agent-browser wait 2000 && agent-browser snapshot -i

  # Reconnect — hit authorize directly or click Connect, then authorize
  agent-browser open "https://www.vm7.ai:8443/api/connectors/<connector-name>/authorize"
  agent-browser wait 5000 && agent-browser snapshot -i
  # If already logged into the provider, the consent page appears — click Authorize directly
  agent-browser click @<authorize-button-ref>
  agent-browser wait 5000 && agent-browser snapshot -i
  # If provider login is required, stop and ask the user to log in first
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
