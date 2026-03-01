## Add OAuth Connector Checklist

1. Create a PR similar to #3332.
2. Ensure you use the real product SVG logo from the Internet, not a placeholder image.
3. Ask the user to provide OAuth credentials to GitHub — both the client ID and client secret. Show the `gh` command as an example, but do not run the command on the user's behalf. Provide two sets of credentials: one for the default/dev environment and one for production. Be careful to distinguish between secrets and vars.
4. Verify that the secrets/vars are correctly set on GitHub.
5. Ensure that `.env.tpl` references the correct secrets/vars and that the secret/var names in 1Password match the environment variable names. Ask the user to create the secrets/vars in 1Password, then have them run `sync-env.sh`.
6. Make sure the local `.env.local` contains the correct secret/var values.
7. Ask the user to start the project locally with `pnpm dev` and verify that it can successfully connect to the OAuth provider and obtain user information.
8. Check the `vm0-ai/vm0-skills` repository for a related skill. If one exists, ensure the skill's `vm0_secret` uses the environment variable injected by this connector. If it does not, modify the skill and open a PR for the skill repository.
9. Help the user create a local agent example, for instance:

vm0.yaml
```yaml
version: "1.0"

agents:
  agent:
    framework: claude-code
    instructions: AGENTS.md
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/gmail
```

AGENTS.md
```text
test every example in skill gmail
```

Then run:

```bash
vm0 cook "let's do it"
```

10. If everything works, the connector is ready to be merged.

