## Connector Status Check

Before starting work on an OAuth connector, run these checks to determine which stage it is at. The stages correspond to the [OAuth Providers board on Notion](https://www.notion.so/3170e96f013480ca98b3ffe66f4a4feb?v=3170e96f013480ceb2ab000c69423785).

### Quick Diagnosis

Run all checks for a given `<PROVIDER>` (e.g., `hubspot`, `todoist`, `gmail`). Use the **uppercase** env-var prefix (e.g., `HUBSPOT`, `TODOIST`, `GOOGLE`) where indicated.

| # | Check | Command / Location | What it tells you |
|---|-------|--------------------|-------------------|
| 1 | **Connector code exists** | `ls turbo/apps/web/src/lib/connector/providers/<provider>*.ts` | Whether implementation has started |
| 2 | **CONNECTOR_TYPES entry** | `grep '<provider>' turbo/packages/core/src/contracts/connectors.ts` | Whether the connector is registered |
| 3 | **Feature switch exists** | `grep '<provider>' turbo/packages/core/src/feature-switch.ts` | Whether the connector is behind a feature flag |
| 4 | **Feature switch enabled** | Check `enabled: true/false` in `FEATURE_SWITCHES[FeatureSwitchKey.<Provider>Connector]` in `turbo/packages/core/src/feature-switch.ts` | `false` = still gated (dev/testing); removed from `CONNECTOR_FEATURE_FLAGS` or `true` = public |
| 5 | **`.env.tpl` entry** | `grep '<PREFIX>_OAUTH' turbo/apps/web/.env.local.tpl` | Whether 1Password references are set up |
| 6 | **GitHub vars/secrets** | `gh variable list \| grep <PREFIX>_OAUTH` and `gh secret list \| grep <PREFIX>_OAUTH` | Whether CI/CD credentials are synced |
| 7 | **Workflow env vars** | `grep '<PREFIX>_OAUTH' .github/workflows/turbo.yml .github/workflows/release-please.yml` | Whether deploy pipelines pass the credentials |
| 8 | **Skill exists** | Check `vm0-ai/vm0-skills` repo for a `<provider>` skill directory | Whether a skill has been authored |
| 9 | **Production app registered** | Check `/tmp/oauth-credentials/<PROVIDER>` for `_PROD` fields, or `gh variable list \| grep <PREFIX>_OAUTH_CLIENT_ID_PROD` | Whether the production OAuth app exists |

### Stage Mapping

Based on the checks above, determine the current stage:

| Stage | Notion Status | Signals |
|-------|---------------|---------|
| **Not started** | — | No connector code, no feature switch, no env vars |
| **Dev App Registration** | Dev App Registration | `/tmp/oauth-credentials/<PROVIDER>` may exist with non-`_PROD` fields; no connector code yet |
| **Development & Testing** | Development & Testing | Connector code exists (checks 1–2 pass); feature switch exists and `enabled: false` (check 3–4); `.env.tpl` and workflow entries present (checks 5, 7); GitHub vars/secrets synced (check 6) |
| **Skill Testing** | Skill Testing | All of the above, plus a skill exists in `vm0-ai/vm0-skills` (check 8); `vm0 cook` has been run to validate |
| **Prod App Registration** | Prod App Registration | Skill tests pass; production OAuth app registration in progress (check 9 partially done) |
| **Done** | Done | All checks pass; feature switch removed or set to `enabled: true`; production credentials synced; PR merged |

### Example

```bash
# Quick status check for "hubspot"
PROVIDER=hubspot
PREFIX=HUBSPOT

# 1–2: Code & registration
ls turbo/apps/web/src/lib/connector/providers/${PROVIDER}*.ts 2>/dev/null && echo "✓ Code exists" || echo "✗ No code"
grep -q "\"${PROVIDER}\"" turbo/packages/core/src/contracts/connectors.ts && echo "✓ CONNECTOR_TYPES entry" || echo "✗ Not in CONNECTOR_TYPES"

# 3–4: Feature switch
grep -q "${PROVIDER}" turbo/packages/core/src/feature-switch.ts && echo "✓ Feature switch exists (check enabled state manually)" || echo "✗ No feature switch"

# 5: .env.tpl
grep -q "${PREFIX}_OAUTH" turbo/apps/web/.env.local.tpl && echo "✓ .env.tpl entry" || echo "✗ Not in .env.tpl"

# 6: GitHub vars/secrets
gh variable list 2>/dev/null | grep -q "${PREFIX}_OAUTH" && echo "✓ GitHub vars set" || echo "✗ No GitHub vars"
gh secret list 2>/dev/null | grep -q "${PREFIX}_OAUTH" && echo "✓ GitHub secrets set" || echo "✗ No GitHub secrets"

# 7: Workflow env vars
grep -q "${PREFIX}_OAUTH" .github/workflows/turbo.yml && echo "✓ turbo.yml" || echo "✗ Not in turbo.yml"
grep -q "${PREFIX}_OAUTH" .github/workflows/release-please.yml && echo "✓ release-please.yml" || echo "✗ Not in release-please.yml"

# 8: Skill (check vm0-ai/vm0-skills repo manually or via gh)

# 9: Production app
test -f "/tmp/oauth-credentials/${PROVIDER}" && grep -q "_PROD" "/tmp/oauth-credentials/${PROVIDER}" && echo "✓ Prod credentials file" || echo "✗ No prod credentials"
```

---

## Authentication Strategy

Before writing any code, determine which authentication methods the provider supports. This decision drives the entire implementation path.

### Decision Matrix

| # | Provider supports | Auth methods to implement | Feature switch for OAuth? | Notes |
|---|-------------------|--------------------------|---------------------------|-------|
| 1 | OAuth (review required) + API token | Both `oauth` and `api-token` | Yes (`enabled: false`) | OAuth stays gated until review is approved; API token is available immediately |
| 2 | OAuth (no review) + API token | Both `oauth` and `api-token` | Yes (`enabled: false`) | OAuth gated during dev/testing; remove switch when ready to ship |
| 3 | OAuth only (no API token) | `oauth` only | Yes (`enabled: false`) | Standard OAuth-only connector |
| 4 | API token only (no OAuth) | `api-token` only | No | No OAuth registration needed; skip straight to implementation |

### Secret Naming for API Token

When a connector supports both OAuth and API token, the API token **must write directly to the same target secret** that the OAuth flow's `environmentMapping` maps to — not the intermediate OAuth access token.

Example: if the OAuth flow produces `XXX_ACCESS_TOKEN` and the `environmentMapping` maps it to `XXX_TOKEN`:

```
# OAuth flow (environment mapping handles the rename):
XXX_ACCESS_TOKEN  →  environmentMapping  →  XXX_TOKEN

# API token flow (writes directly to the target — no mapping step):
user-provided token  →  XXX_TOKEN
```

This means:
- The `api-token` auth method does **not** need an `environmentMapping` entry.
- The secret key written by the API token flow (`XXX_TOKEN`) must match the `vm0_secrets` name declared in the corresponding skill in `vm0-ai/vm0-skills`.
- Both auth methods ultimately produce the same secret key, so the skill works identically regardless of how the user authenticated.

**Naming convention:** The target secret must follow the `XXX_TOKEN` pattern (e.g., `FIGMA_TOKEN`, `MERCURY_TOKEN`). Do not encode the token type in the name (no `_API_KEY`, `_PERSONAL_API_KEY`, `_SECRET_KEY`, `_ACCESS_TOKEN`).

### How to Determine

1. Check the provider's developer documentation for OAuth support (authorization code flow).
2. Check whether the provider offers personal API tokens / API keys from a dashboard.
3. If OAuth is supported, check whether a review/approval process is required before external users can authorize (see [Step 5 of Skill Validation Loop](#step-5-check-production-oauth-app-requirements-ai) for common patterns).
4. Based on the findings, pick the matching row from the decision matrix above and follow the corresponding implementation path.

---

## OAuth App Registration

Before writing any code, register the OAuth application with the provider. The client ID and client secret generated during registration are required for implementation.

> **Skip this section** if the provider is API-token-only (Decision Matrix row 4). Proceed directly to [Add OAuth Connector Checklist](#add-oauth-connector-checklist).

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

Use `agent-browser` (in headed mode via noVNC — the user watches and can intervene) to navigate the provider's developer portal, filling in each field above. Stop and ask the user to confirm before submitting any form that creates or modifies an app registration. For logo upload, always stop and let the user handle it manually via the noVNC viewer.

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
1. **Feature switch:** Only connectors with an OAuth flow (Decision Matrix rows 1–3) need a feature switch (`enabled: false`). API-token-only connectors (row 4) do **not** need a feature switch — they are always visible once merged.
1. **OAuth env vars (skip for API-token-only):** Add the OAuth env vars to both `.github/workflows/turbo.yml` and `.github/workflows/release-please.yml` deploy steps (client ID from `vars`, client secret from `secrets`).
1. **`.env.tpl` (skip for API-token-only):** Ensure that `.env.tpl` references the correct secrets/vars and that the secret/var names in 1Password match the environment variable names.
1. **Credential sync (skip for API-token-only):** Run `bash scripts/sync-oauth.sh PROVIDER_NAME` to sync credentials from `/tmp/oauth-credentials/<PROVIDER>` to 1Password and GitHub. If any fields are missing, fill them in and re-run. Wait for the user to confirm completion.
1. **Verify GitHub secrets (skip for API-token-only):** Verify that the secrets/vars are correctly set on GitHub by running `gh variable list | grep PROVIDER` and `gh secret list | grep PROVIDER`.
1. Make sure the local `.env.local` contains the correct secret/var values.
1. Commit all changes and create a PR using `/pull-request`. This lets CI validate the implementation in parallel while you do local testing.
1. Start the project locally using `/dev-tunnel` (starts the dev server, creates a Cloudflare tunnel, and sets up the proxy). Verify the server is running and accessible before proceeding.

1. **Start the noVNC stack for `agent-browser`.** All subsequent `agent-browser` commands in this guide run in headed mode inside the devcontainer, with the user connecting via noVNC to observe and assist.

   **Install prerequisites (if missing):**
   ```bash
   which x11vnc || sudo apt-get update -qq && sudo apt-get install -y -qq x11vnc novnc openbox
   ```

   **Start the VNC stack (idempotent — safe to run multiple times):**

   **Important:** Each process must be wrapped in subshell `()` to avoid `||` and `&` operator precedence issues that can silently prevent later processes (especially websockify) from launching. Also, websockify must bind to `0.0.0.0:6080` (not just `6080`) so it's accessible from the host.

   ```bash
   pgrep -x Xvfb > /dev/null || (Xvfb :99 -screen 0 1344x840x24 > /dev/null 2>&1 &)
   sleep 1
   pgrep -x openbox > /dev/null || (DISPLAY=:99 openbox > /dev/null 2>&1 &)
   sleep 1
   pgrep -x x11vnc > /dev/null || (x11vnc -display :99 -nopw -forever -shared -rfbport 5900 > /dev/null 2>&1 &)
   sleep 1
   pgrep -f websockify > /dev/null || (websockify --web /usr/share/novnc/ 0.0.0.0:6080 localhost:5900 > /dev/null 2>&1 &)
   sleep 1
   ```

   **Tell the user to connect via noVNC:**
   > The browser is running in headed mode with noVNC. To view and interact with it, run:
   >
   > ```
   > dcvnc <vm_name>
   > ```
   >
   > (e.g., `dcvnc vm01`). This opens the noVNC viewer in your default browser. You can watch the OAuth flow and intervene when credentials are needed.

   All `agent-browser` commands below must use `DISPLAY=:99` and `--headed`. For local HTTPS dev servers, add `--ignore-https-errors`. Refs (`@e1`, `@e2`, etc.) are dynamic — always run `snapshot -i` to get fresh refs before interacting.

1. **Set up CLI authentication, scope, and model provider.** These are required before the OAuth flow and skill validation will work.

   **Step A: CLI authentication**

   Run `vm0 auth login` in the background — it will print a device code and wait for browser confirmation. Then use `agent-browser` (headed, via noVNC) to complete the login flow:

   ```bash
   # Start auth login in background (captures the device code URL)
   vm0 auth login &
   AUTH_PID=$!

   # Open the CLI auth page and complete sign-in
   DISPLAY=:99 agent-browser --headed --ignore-https-errors open "https://www.vm7.ai:8443/cli-auth"
   agent-browser wait 3000 && agent-browser snapshot -i

   # Sign up (first time) or sign in with Clerk test credentials
   # Use any email containing +clerk_test (e.g., test+clerk_test@example.com)
   agent-browser fill @<email-ref> "test+clerk_test@example.com"
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

   # Enter the device code shown by `vm0 auth login` and confirm
   # Wait for the background process to complete
   wait $AUTH_PID
   ```

   > Alternatively, if the dev server exposes a test-token endpoint (`/api/cli/auth/test-token`), you can use that to get a token directly without the browser flow.

   Verify authentication:
   ```bash
   vm0 auth status
   # Expected: "✓ Authenticated"
   ```

   **Step B: Ensure scope exists**

   ```bash
   vm0 scope status
   ```

   If no scope is configured, create one:
   ```bash
   vm0 scope set test-user-scope
   ```

   > If `vm0 scope set` fails with a 500 error (Clerk org creation fails in dev), create the scope directly in the database:
   > ```bash
   > psql "$DATABASE_URL" -c "INSERT INTO scopes (slug, clerk_org_id) VALUES ('test-user-scope', 'org_test') RETURNING id, slug;"
   > # Then create the scope membership using the returned scope ID and user ID from `vm0 auth status`:
   > psql "$DATABASE_URL" -c "INSERT INTO scope_members (scope_id, user_id, role) VALUES ('<scope-id>', '<clerk-user-id>', 'admin');"
   > ```

   **Step C: Configure model provider**

   ```bash
   vm0 model-provider list
   ```

   If no model provider is configured, ask the user which provider to use:

   | Provider | Type | Secret format |
   |----------|------|---------------|
   | Claude Code (OAuth) | `claude-code-oauth-token` | `sk-ant-oat01-...` |
   | Moonshot (Kimi) | `moonshot-api-key` | API key from platform.moonshot.cn |

   Then configure it:
   ```bash
   vm0 model-provider setup --type <type> --secret "<key>"
   ```

   **Verify all prerequisites:**
   ```bash
   vm0 auth status          # ✓ Authenticated
   vm0 scope status         # Shows scope slug
   vm0 model-provider list  # Shows default provider for claude-code
   ```

1. **Connect the OAuth provider.** Use `agent-browser` in headed mode (the user watches via noVNC):

   ```bash
   DISPLAY=:99 agent-browser --headed --ignore-https-errors open "https://www.vm7.ai:8443/api/connectors/<connector-name>/authorize"
   agent-browser wait 5000 && agent-browser snapshot -i
   ```

   > **Important:** The OAuth flow has two distinct stages:
   > 1. **Provider login page** (if not already logged in) — requires the user's real account credentials. Stop and ask the user to log in via the noVNC viewer, then continue.
   > 2. **Authorization/consent page** — the page asking to grant permissions to our app. This can be clicked directly with `agent-browser click @<authorize-button-ref>` without human confirmation.

   **If the callback returns an error page**, check the dev server logs and the error message in the URL. Before diving into code, **search the web for the error** — provider-specific quirks (e.g., OAuth scopes appended to the callback URL, non-standard token response shapes) are often documented in community forums or the provider's own changelog. Use `WebSearch` with the provider name and the error message to see if others have encountered the same issue.

## API-Token-Only Quick Validation

For connectors that only support API tokens (Decision Matrix row 4), there is no OAuth registration, no feature switch, and no connector provider code to write. The implementation is just the `CONNECTOR_TYPES` entry plus a skill. Use this streamlined flow to validate the skill quickly.

### Prerequisites

Ensure the dev server is running and the CLI is authenticated:

```bash
vm0 auth status          # ✓ Authenticated
vm0 scope status         # Shows scope slug
vm0 model-provider list  # Shows default provider
```

If any of these are not set up, follow [Step C in the Add OAuth Connector Checklist](#add-oauth-connector-checklist) for CLI auth, scope, and model provider setup.

### Step 1: Obtain the API token [AI + Human]

Use `agent-browser` in headed mode (via noVNC) to navigate the provider's developer portal and generate an API token. This is similar to the OAuth app registration flow — the user may need to assist with login.

1. **Start the noVNC stack** (if not already running) — see the [noVNC setup instructions](#add-oauth-connector-checklist) in the OAuth checklist.

2. **Navigate to the provider's API token page:**

   ```bash
   DISPLAY=:99 agent-browser --headed open "https://<provider-developer-portal-url>"
   agent-browser wait 3000 && agent-browser snapshot -i
   ```

3. **If provider login is required**, stop and ask the user to log in via the noVNC viewer, then continue.

4. **Generate or copy the API token.** Navigate to the API keys / tokens section, create a new token if needed, and copy the value.

### Step 2: Set the secret via CLI [AI]

Use `vm0 secret set` to store the API token under the name declared in the connector's `environmentMapping`:

```bash
vm0 secret set <SECRET_NAME> "<api-token-value>"
```

For example, for SimilarWeb:

```bash
vm0 secret set SIMILARWEB_TOKEN "your-similarweb-api-key"
```

The secret name must match both the `environmentMapping` key in `CONNECTOR_TYPES` and the `vm0_secrets` entry in the skill's `SKILL.md`.

### Step 3: Validate with `vm0 cook` [AI]

Follow the standard [Skill Validation Loop](#skill-validation-loop) starting from Step 1 (create or update the skill) through Step 4 (iterate until all examples pass). Since there is no OAuth flow, reconnection is never needed — if the token is wrong or expired, simply re-run `vm0 secret set` with a new token.

### Step 4: Ship [AI]

API-token-only connectors do not need a feature switch and do not require production OAuth app registration. Once the skill passes validation:

1. Commit all changes (connector entry + skill) and create a PR.
2. Ensure CI passes.
3. No feature switch removal needed — the connector is immediately available to all users.

---

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

- **Missing OAuth scopes (401/403):** The connector requested insufficient scopes. Fix the scopes in the connector code, then reconnect using `agent-browser` (the user watches and assists via noVNC):
  ```bash
  # Navigate to connections settings
  DISPLAY=:99 agent-browser --headed --ignore-https-errors open "https://www.vm7.ai:8443/settings?tab=connections"
  agent-browser wait 3000 && agent-browser snapshot -i

  # Disconnect the existing connector
  agent-browser click @<disconnect-button-ref>
  agent-browser wait 2000 && agent-browser snapshot -i

  # Reconnect — hit authorize directly or click Connect, then authorize
  DISPLAY=:99 agent-browser --headed --ignore-https-errors open "https://www.vm7.ai:8443/api/connectors/<connector-name>/authorize"
  agent-browser wait 5000 && agent-browser snapshot -i
  # If already logged into the provider, the consent page appears — click Authorize directly
  agent-browser click @<authorize-button-ref>
  agent-browser wait 5000 && agent-browser snapshot -i
  # If provider login is required, stop and ask the user to log in via the noVNC viewer
  ```
- **Credits/quota depleted:** The OAuth provider's API has usage limits. The connector itself is working if at least one endpoint succeeds (e.g., `/users/me`).

### Step 4: Re-run and iterate [AI]

After fixes:

- **Skill-only changes** (jq fields, example tweaks, documentation): Push to `vm0-skills` main, re-run `vm0 cook`. No human needed.
- **Connector code changes** (response parsing, error handling): Re-run `vm0 cook`. No human needed — the dev server hot-reloads.
- **Scope changes**: Disconnect and reconnect the connector via `agent-browser` with noVNC (see Step 3 scope fix above), then re-run `vm0 cook`.

Repeat Steps 2–4 until all examples pass.

### Step 5: Check production OAuth app requirements [AI]

Before shipping, search the web to determine whether the provider's production OAuth app requires a publishing/review/approval process before external users can authorize it. Common patterns:

| Pattern | Examples | Action |
|---------|----------|--------|
| **No review needed** — fill in support info (email, privacy policy, ToS) and the app is live | Airtable, Linear | Fill in the fields in the provider's developer portal and proceed to ship. |
| **Review required** — the provider must approve the app before external users can use it | Google (OAuth consent screen verification), Slack (App Directory review), Notion (public integration review) | The connector stays behind the feature switch. Move the provider's Notion page to the "App 申请" column and update it with the submission instructions (see below). Hand off to ops. |
| **No restrictions** — any registered OAuth app works for all users immediately | GitHub, Reddit | Proceed to ship directly. |

**If review is required:**

1. Open the project tracker in Notion: `https://www.notion.so/3170e96f013480ca98b3ffe66f4a4feb`
2. Find the page for this connector/provider.
3. Move it to the **App 申请** (App Review) column.
4. Update the page content with:
   - The provider's review/submission URL and process
   - What information is needed (app description, screenshots, privacy policy, etc.)
   - Current status of the production app (app ID, redirect URIs configured, scopes requested)
   - Any special notes (e.g., "requires business verification", "takes 2-4 weeks")
5. The feature switch stays **disabled** until the review is approved. Once ops confirms approval, remove the feature switch to make the connector public.

### Step 6: Ship [AI]

If no review is required (or after review approval):

1. Remove the feature switch to make the connector public.
2. Clean up the test directory: `cd .. && rm -rf test-<connector-name>-connector`
3. Commit, push, and ensure CI passes.
