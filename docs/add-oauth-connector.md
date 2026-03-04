## Add OAuth Connector Checklist

1. Use existing OAuth connectors (e.g., Gmail, Notion, Linear) as templates for implementation.
1. Ensure you use the real product SVG logo from the Internet, not a placeholder image.
1. Ensure the new connector is protected with a feature switch, and that the feature switch is disabled by default.
1. Ask the user to provide OAuth credentials to GitHub — both the client ID and client secret. Show the `gh` command as an example, but do not run the command on the user's behalf. Provide two sets of credentials: one for the default/dev environment and one for production. Be careful to distinguish between secrets and vars.
1. Verify that the secrets/vars are correctly set on GitHub.
1. Add the OAuth env vars to both `.github/workflows/turbo.yml` and `.github/workflows/release-please.yml` deploy steps (client ID from `vars`, client secret from `secrets`).
1. Ensure that `.env.tpl` references the correct secrets/vars and that the secret/var names in 1Password match the environment variable names. Ask the user to create the secrets/vars in 1Password, then have them run `sync-env.sh`.
1. Make sure the local `.env.local` contains the correct secret/var values.
1. Ask the user to start the project locally with `pnpm dev` and verify that it can successfully connect to the OAuth provider and obtain user information.
1. Check the `vm0-ai/vm0-skills` repository for a related skill.
   - If one exists, ensure the skill's `vm0_secrets` matches the environment variable key from the connector's `environmentMapping` (e.g., connector maps `X_ACCESS_TOKEN: "$secrets.X_ACCESS_TOKEN"` → skill declares `vm0_secrets: [X_ACCESS_TOKEN]`).
   - If it does not match, modify the skill and open a PR for the skill repository.
   - If no skill exists, create one following `docs/skill-template.md` in `vm0-ai/vm0-skills`, then open a PR.
1. Create a test directory and set up a local agent to test the skill end-to-end:

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

AGENTS.md

```text
test every example in skill <skill-name>
```

Then run:

```bash
vm0 cook --yes "let's do it"
```

> **Note:** The `--yes` flag is required to auto-approve new secrets detected from the skill. Without it, compose will fail in non-interactive mode.

12. Review the test results. The agent will execute every curl example from the skill and report which ones succeed or fail. Common issues:
    - **Authentication errors (401/403):** Check that the connector's `environmentMapping` key matches the env var used in the skill's curl commands.
    - **Credits/quota depleted:** The OAuth provider's API has usage limits. The connector itself is working if at least one endpoint succeeds (e.g., `/users/me` for X).
    - **Variable not injected:** Ensure `vm0_secrets` in the skill matches the key (not the value) of the connector's `environmentMapping`.
1. Clean up the test directory after verification:

```bash
cd .. && rm -rf test-<connector-name>-connector
```

14. If everything works, the connector is ready to be merged.
