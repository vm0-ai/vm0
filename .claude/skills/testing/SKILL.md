---
name: testing
description: Comprehensive testing patterns and anti-patterns for writing and reviewing tests
context: fork
---

# Testing Skill

Use this skill when writing tests, reviewing test code, or investigating test failures.

## Documentation

Read the testing guide and relevant reference based on context:

| Context | Primary | Reference |
|---------|---------|-----------|
| General | [docs/testing.md](../../../docs/testing.md) | — |
| Anti-patterns | [docs/testing.md](../../../docs/testing.md) | [anti-patterns.md](../../../docs/testing/anti-patterns.md) |
| Patterns | [docs/testing.md](../../../docs/testing.md) | [patterns.md](../../../docs/testing/patterns.md) |
| CLI (`turbo/apps/cli`) | [docs/testing.md](../../../docs/testing.md) | [cli-testing.md](../../../docs/testing/cli-testing.md) |
| CLI E2E (`e2e/tests/`) | [docs/testing.md](../../../docs/testing.md) | [cli-e2e-testing.md](../../../docs/testing/cli-e2e-testing.md) |
| Web (`turbo/apps/web`) | [docs/testing.md](../../../docs/testing.md) | [web-testing.md](../../../docs/testing/web-testing.md) |
| Platform (`turbo/apps/platform`) | [docs/testing.md](../../../docs/testing.md) | [platform-testing.md](../../../docs/testing/platform-testing.md) |

## Key Principles

1. **Integration tests are primary** — test at system entry points
2. **Mock at the boundary** — only mock external services, not internal code
3. **Use real infrastructure** — real database, real filesystem (temp dirs)
4. **Test behavior, not implementation** — verify outcomes, not mock calls
