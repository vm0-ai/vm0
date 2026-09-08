---
name: commit
description: Select applicable checks and validate or create a focused conventional commit
context: fork
---

# Commit

Use `check` to verify staged work, `message` to propose or validate its message,
or both when a commit is requested.

## Scope and Checks

1. Inspect `git status --short`, `git diff`, and `git diff --cached`. Stage only
   the requested change; preserve unrelated worktree and staged content.
2. Follow [development and verification](../../../CLAUDE.md#development-and-verification)
   for the affected files, workspaces, generated outputs, and runtime consumers.
   Read the matching [testing guide](../../../docs/testing.md) when behavior
   changes.
3. Run applicable formatting, lint/static analysis, type checks, and tests.
   Await each heavy check; run one Vitest or Cargo check at a time.
4. Fix actual failures. After checks pass, repeat them only if a new change,
   failure, or unresolved concern warrants it. Documentation does not require
   unrelated language suites.

`lefthook.yml` is the staged-file hook configuration. Hooks do not replace
behavior verification. For local Rust `ENOMEM` failures, check for competing
compiler/linker processes and retry once with `CARGO_BUILD_JOBS=1`; investigate
actual compiler failures separately. Do not delete installed dependencies as a
generic response to a slow hook.

## Message

Use `<type>[optional scope]: <description>`. The authoritative rules and allowed
types are in [commitlint.config.mjs](../../../commitlint.config.mjs): lowercase
type and subject, no final period, and at most 100 header characters. Use an
imperative description of the actual change.

Examples:

- `feat: add agent sharing`
- `fix(api): preserve webhook idempotency`
- `docs: simplify testing guidance`

Choose the type from the change, not from a desired version bump. See
[release behavior](release-triggers.md) when release impact matters.

Before committing, review the complete staged diff and relevant check results.
Report the commit SHA, scope, and validation; distinguish failed or unrun checks
from passes. Push or open a PR when requested by the caller.
