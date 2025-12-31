# Review: 194dfa6e - fix(runner): add postbuild script for npm publish

**Commit:** 194dfa6e20d930bdd8d0636b68d6551355351ed3
**Author:** Lancy <lancy@vm0.ai>
**Date:** 2025-12-31

## Summary

This commit adds a `postbuild` script to the runner package to prepare `dist/package.json` for npm publishing, mirroring the CLI package's approach.

## Files Changed

| File                             | Changes  |
| -------------------------------- | -------- |
| `turbo/apps/runner/package.json` | +2 lines |
| `turbo/pnpm-lock.yaml`           | +3 lines |

## Review Checklist

### Code Quality

- [x] **Follows existing patterns**: The postbuild script mirrors the CLI package's approach exactly
- [x] **No unnecessary complexity**: Simple, single-purpose change
- [x] **No over-engineering**: Uses existing tooling (`json` package) already in the monorepo

### Specific Changes

#### 1. postbuild script addition

```json
"postbuild": "cp package.json dist/ && pnpm json -I -f dist/package.json -e 'this.name=\"@vm0/runner\"; delete this.private; delete this.scripts; delete this.devDependencies; this.bin[\"vm0-runner\"]=\"index.js\"; this.files=[\".\"]'"
```

**Analysis:**

- Correctly copies `package.json` to `dist/`
- Removes `private: true` (required for npm publish)
- Removes `scripts` and `devDependencies` (not needed in published package)
- Adjusts `bin` path from `./dist/index.js` to `index.js` (correct for publish from dist)
- Sets `files` to `["."]` (correct for publish from dist)

**Comparison with CLI:**
The CLI has an additional deletion: `delete this.dependencies["@vm0/core"]` because it bundles the `@vm0/core` workspace package. The runner doesn't have this dependency, so it's correctly omitted.

#### 2. json devDependency addition

```json
"json": "^11.0.0"
```

**Analysis:**

- Same version as CLI uses
- Required for the `pnpm json` command in postbuild
- Correctly added to devDependencies (not runtime dependency)

### Bad Code Smell Analysis

- [x] **No new mocks introduced**: N/A - build script only
- [x] **No unnecessary try/catch**: N/A - build script only
- [x] **No timer/delay misuse**: N/A - build script only
- [x] **No dynamic imports**: N/A - build script only
- [x] **Interface changes**: None - build configuration only

### Test Coverage

- [x] Existing tests pass (13 tests in runner package)
- [x] Build verification performed locally
- [x] `dist/package.json` output verified

## Verdict

**APPROVED**

This is a minimal, well-targeted fix that:

1. Follows the established pattern from the CLI package
2. Makes no unnecessary changes
3. Correctly addresses the npm publish failure
4. Has been verified locally

No issues found.
