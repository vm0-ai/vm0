# Code Review: 4dfcb9c2

**Commit:** refactor: rename beta_network_security to experimental_network_security

## Summary

This commit performs a straightforward rename of the `beta_network_security` configuration field to `experimental_network_security` across 8 files for consistency with other experimental features in the project.

## Files Changed

| File                                                  | Type of Change                |
| ----------------------------------------------------- | ----------------------------- |
| `turbo/packages/core/src/contracts/composes.ts`       | Schema field rename           |
| `turbo/apps/web/src/types/agent-compose.ts`           | Interface field rename        |
| `turbo/apps/web/src/lib/run/types.ts`                 | ExecutionContext field rename |
| `turbo/apps/web/src/lib/run/run-service.ts`           | Variable and comment updates  |
| `turbo/apps/web/src/lib/e2b/e2b-service.ts`           | Variable updates              |
| `turbo/apps/web/src/lib/e2b/scripts/lib/common.py.ts` | Comment update                |
| `e2e/fixtures/configs/vm0-network-security.yaml`      | Config field rename           |
| `e2e/tests/02-commands/t16-vm0-network-logs.bats`     | Comment update                |

## Review Checklist

### ✅ Naming Consistency

- [x] YAML field uses snake_case: `experimental_network_security`
- [x] TypeScript variables use camelCase: `experimentalNetworkSecurity`
- [x] All references updated consistently across codebase

### ✅ Breaking Change Documentation

- [x] BREAKING CHANGE noted in commit message
- [x] Migration path documented (update agent.yaml)

### ✅ Test Coverage

- [x] E2E test configuration updated
- [x] E2E test comments updated
- [x] No new tests needed (pure rename)

### ✅ Code Quality

- [x] No new mocks introduced
- [x] No unnecessary try/catch blocks
- [x] No over-engineering
- [x] No timer/delay patterns introduced

## Issues Found

**None** - This is a clean refactoring commit.

## Suggestions

1. **Documentation Update**: Consider updating any external documentation or README files that reference `beta_network_security`.

2. **Database Migration**: If old configurations exist in the database with `beta_network_security`, a migration script may be needed in production (noted in the research phase but not addressed in this commit - may be acceptable if user base is limited).

## Verdict

✅ **APPROVED** - Clean refactoring with no code quality issues. All naming conventions followed correctly.
