## Add OAuth Connector Checklist

1. Use existing OAuth connectors (e.g., Gmail, Notion, Linear) as templates for implementation.
1. Ensure you use the real product SVG logo from the Internet, not a placeholder image.
1. Ensure the new connector is protected with a feature switch, and that the feature switch is disabled by default.
1. Add the OAuth env vars to both `.github/workflows/turbo.yml` and `.github/workflows/release-please.yml` deploy steps (client ID from `vars`, client secret from `secrets`).
1. Ensure that `.env.tpl` references the correct secrets/vars and that the secret/var names in 1Password match the environment variable names.
1. Ask the user to fill in the OAuth credentials (client ID and client secret) in 1Password (both Development and Production vaults), then run `bash scripts/sync-oauth.sh PROVIDER_NAME` to sync credentials from 1Password to GitHub vars/secrets. Wait for the user to confirm completion.
1. Verify that the secrets/vars are correctly set on GitHub by running `gh variable list | grep PROVIDER` and `gh secret list | grep PROVIDER`.
1. Make sure the local `.env.local` contains the correct secret/var values.
1. **[Human]** Start the project locally with `pnpm dev` and verify that it can successfully connect to the OAuth provider and obtain user information. This step requires a browser to complete the OAuth flow.

## Skill Validation Loop

After the connector is verified locally, iterate on the skill and connector code until all API examples pass. This is a loop between AI-driven testing and human-assisted OAuth reconnection.

### Step 1: Create or update the skill [AI]

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

- **Missing OAuth scopes (401/403):** The connector requested insufficient scopes. Fix the scopes in the connector code, then ask the user to: (1) restart dev server, (2) disconnect and reconnect the connector in the browser to obtain a new token with updated scopes.
- **Credits/quota depleted:** The OAuth provider's API has usage limits. The connector itself is working if at least one endpoint succeeds (e.g., `/users/me`).

### Step 4: Re-run and iterate [AI + Human when scopes change]

After fixes:

- **Skill-only changes** (jq fields, example tweaks, documentation): Push to `vm0-skills` main, re-run `vm0 cook`. No human needed.
- **Connector code changes** (response parsing, error handling): Re-run `vm0 cook`. No human needed — the dev server hot-reloads.
- **Scope changes**: Requires the human to restart dev server and re-authorize the connector in the browser. Then re-run `vm0 cook`.

Repeat Steps 2–4 until all examples pass.

### Step 5: Clean up [AI]

```bash
cd .. && rm -rf test-<connector-name>-connector
```

### Step 6: Ship [AI + Human]

If everything works, the connector is ready to be merged. Remove the feature switch to make the connector public.
