# PR #803 Code Review - Separate Secrets from Vars

**PR Title:** feat: separate secrets from vars in checkpoint/session system
**Author:** lancy
**URL:** https://github.com/vm0-ai/vm0/pull/803

## Commits to Review

- [ ] `9dd1e752` feat(sandbox): add client-side secret masking
- [ ] `18c36a8d` refactor(types): add secret-names field and deprecate secrets
- [ ] `93c4c401` feat(db): add secret_names column to agent_runs and agent_sessions
- [ ] `5ffbddc1` refactor(services): use secret-names instead of secrets
- [ ] `2b7b39db` refactor(api): store secret-names instead of encrypted secrets
- [ ] `63c906d8` refactor(webhooks): remove server-side secret masking
- [ ] `761d9d54` feat(cli): add --vars and --secrets to resume/continue commands
- [ ] `93015440` fix(db): register migration 0047 in drizzle journal
- [ ] `f0a85509` test: remove server-side masking tests (now client-side)
- [ ] `c7d8e2d3` test(e2e): update secrets tests - must be re-provided on continue/resume
- [ ] `55da8d84` fix(sandbox): pass secret values for client-side masking
- [ ] `d18c9aac` refactor(db): remove deprecated secrets column from database

## Summary

This PR implements a security improvement where secret values are never stored in the database. Instead:

- Only secret names are stored for validation purposes
- Secret values must be provided at runtime via `--secrets` flag
- Client-side masking in the sandbox ensures secrets are masked before being sent to the server
