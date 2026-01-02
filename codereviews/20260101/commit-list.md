# PR #851 Code Review - @vm0/runner MVP

## Commits Reviewed

- [x] de7f1ff7 feat(web): add runners table for self-hosted runner registration
- [x] 168094cf feat(core,web): add runner registration api
- [x] ab7f8c57 feat(runner): implement setup command with device flow authentication
- [x] 6d587278 feat(db): add runner fields to agent_runs table
- [x] 4ed34d44 feat(core): add experimental_runner field to agent compose schema
- [x] f85b82a4 feat(api): add runner routing for experimental_runner compose option
- [x] fa4df630 feat(api): add job polling and claim endpoints for runners
- [x] 40029850 feat(runner): implement polling loop and api client
- [x] a02df598 test(e2e): add experimental_runner compose tests and update runner cli
- [x] b34c92bd feat(runner): add job completion reporting and e2e tests
- [x] 39f69c05 feat(runner): implement firecracker vm execution (phases 4-5)
- [x] c2c34516 refactor(runner): replace ssh with vsock, remove stub mode and delays
- [x] 7741aa52 fix(e2e): add --yes flag to skill frontmatter tests
- [x] fcbc3cbc feat(cli): add --yes flag to cook command and fix skill tests
- [x] 438b0336 fix(e2e): provide mock gh_token for skill mount test

## Review Summary

See [review-summary.md](./review-summary.md) for detailed findings.
