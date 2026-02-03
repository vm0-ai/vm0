---
name: testing
description: Comprehensive testing patterns and anti-patterns for writing and reviewing tests
context: fork
---

# Testing Skill

## When to Use This Skill

Use this skill when:
- Writing new test files
- Reviewing test code in pull requests
- Refactoring existing tests to improve quality
- Investigating test failures or flaky tests
- Ensuring tests follow project standards

## Documentation

All testing patterns, anti-patterns, and reference documentation are maintained in the docs directory:

- **Main documentation**: [docs/testing.md](../../../docs/testing.md)
- **CLI testing**: [docs/testing/cli-testing.md](../../../docs/testing/cli-testing.md)
- **CLI E2E testing**: [docs/testing/cli-e2e-testing.md](../../../docs/testing/cli-e2e-testing.md)
- **Web testing**: [docs/testing/web-testing.md](../../../docs/testing/web-testing.md)
- **Platform testing**: [docs/testing/platform-testing.md](../../../docs/testing/platform-testing.md)

## Quick Reference

When invoked, read the full documentation from `docs/testing.md` and the relevant reference files based on the context:

| Context | Read |
|---------|------|
| CLI commands (`turbo/apps/cli`) | `docs/testing.md` + `docs/testing/cli-testing.md` |
| CLI E2E (`e2e/tests/`) | `docs/testing.md` + `docs/testing/cli-e2e-testing.md` |
| Web routes (`turbo/apps/web`) | `docs/testing.md` + `docs/testing/web-testing.md` |
| Platform (`turbo/apps/platform`) | `docs/testing.md` + `docs/testing/platform-testing.md` |
