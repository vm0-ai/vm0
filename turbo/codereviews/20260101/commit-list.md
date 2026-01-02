# PR #851 Code Review - @vm0/runner MVP

## Commits (All Reviewed)

- [x] de7f1ff7 feat(web): add runners table for self-hosted runner registration
- [x] 168094cf feat(core,web): add runner registration api
- [x] ab7f8c57 feat(runner): implement setup command with device flow authentication
- [x] 6d587278 feat(db): add runner fields to agent_runs table
- [x] 4ed34d44 feat(core): add experimental_runner field to agent compose schema
- [x] f85b82a4 feat(api): add runner routing for experimental_runner compose option
- [x] fa4df630 feat(api): add job polling and claim endpoints for runners
- [x] 40029850 feat(runner): implement polling loop and api client
- [x] a02df598 test(e2e): add experimental_runner compose tests
- [x] 1d36c318 chore: retry ci
- [x] b34c92bd feat(runner): add job completion reporting and e2e tests
- [x] f8bd92b4 fix: add type guard for checkpoint in complete webhook
- [x] 4d338c1f fix(e2e): make runner tests more robust
- [x] e20d4913 fix(runner): add vercel bypass header for preview deployments
- [x] 2eece843 fix(e2e): correct environment variable syntax for runner
- [x] 7437f2bb fix(e2e): replace skip with fail in runner tests
- [x] 39f69c05 feat(runner): implement firecracker vm execution (phases 4-5)
- [x] c2c34516 refactor(runner): replace ssh with vsock, remove stub mode
- [x] 7741aa52 fix(e2e): add --yes flag to skill frontmatter tests
- [x] fcbc3cbc feat(cli): add --yes flag to cook command
- [x] 438b0336 fix(e2e): provide mock gh_token for skill mount test
- [x] 17e222db refactor(runner): move server config into runner.yaml
- [x] 8287bf32 test(runner): add server field to config tests

## Summary

See [review-summary.md](./review-summary.md) for detailed findings.
