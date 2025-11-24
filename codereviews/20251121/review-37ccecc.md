# Review: add codex volume mount to devcontainer

**Commit:** 37ccecc
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Sat Nov 22 15:54:45 2025 +0800

## Summary

This is a minimal configuration change that adds a Docker named volume for persisting Codex data across container rebuilds. Single line addition to `.devcontainer/devcontainer.json` following the same pattern as other tool volumes (vercel, pnpm, mkcert, pki).

Change:

- Added `source=codex,target=/home/vscode/.codex` volume mount

This ensures Codex-related data and cache are retained when the devcontainer is rebuilt.

## Code Smell Analysis

### ✅ Good Practices

- Follows existing volume mounting convention consistently with vercel, pnpm, mkcert, pki volumes
- Minimal, focused change with single responsibility
- Properly placed in devcontainer.json volumes array
- Path structure consistent with other tool volumes (/home/vscode/.toolname pattern)
- No unnecessary additions or over-engineering
- Follows YAGNI principle: simple solution for explicit requirement

### ⚠️ Issues Found

None identified. This is a straightforward configuration addition following established patterns.

### 💡 Recommendations

None required. The implementation is clean and appropriate for the use case.

## Breaking Changes

- None. This is a purely additive configuration change.
- Existing volume mounts remain unchanged.
- Codex volume is created automatically by Docker on first use.

## Additional Notes

This is a good example of minimal, focused changes. The commit is self-contained and doesn't introduce unnecessary complexity or coupling with other systems. Ideal for devcontainer configuration maintenance.
