# Release Triggering Rules

This document explains how conventional commit types trigger automated releases via release-please in the uspark project.

## Overview

The uspark project uses **release-please** for automated versioning and releases. Not all commit types trigger releases - understanding which commits create new versions is critical for proper release management.

## Semantic Versioning

Releases follow semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes
- **MINOR** (1.2.0 → 1.3.0): New features (backward compatible)
- **PATCH** (1.2.0 → 1.2.1): Bug fixes (backward compatible)

## Release Matrix

### ✅ Triggers Release

| Commit Type | Version Bump | Example | New Version |
|-------------|--------------|---------|-------------|
| `feat:` | MINOR | 1.2.0 → 1.3.0 | 1.3.0 |
| `fix:` | PATCH | 1.2.0 → 1.2.1 | 1.2.1 |
| `deps:` | PATCH | 1.2.0 → 1.2.1 | 1.2.1 |
| `<any>!` | MAJOR | 1.2.0 → 2.0.0 | 2.0.0 |
| `BREAKING CHANGE:` | MAJOR | 1.2.0 → 2.0.0 | 2.0.0 |

### ❌ Does NOT Trigger Release

These types appear in the changelog but will NOT create a new release:

- `docs:` - Documentation changes
- `style:` - Code style/formatting
- `refactor:` - Code refactoring
- `test:` - Test changes
- `chore:` - Build/tool changes
- `ci:` - CI configuration
- `perf:` - Performance improvements
- `build:` - Build system changes
- `revert:` - Revert changes

## How Release-Please Works

1. **Commit Analysis**: release-please scans all commits since the last release
2. **Version Calculation**: Determines version bump based on commit types
3. **PR Creation**: Creates a "release PR" with updated version and changelog
4. **Release Creation**: When merged, creates a GitHub release and tags

## Decision Tree: Will My Commit Trigger a Release?

```
Is it a breaking change? (! or BREAKING CHANGE:)
  ├─ YES → MAJOR release (2.0.0)
  └─ NO → Continue...

Is it a new feature? (feat:)
  ├─ YES → MINOR release (1.3.0)
  └─ NO → Continue...

Is it a bug fix or dependency update? (fix: or deps:)
  ├─ YES → PATCH release (1.2.1)
  └─ NO → No release (appears in changelog only)
```

## Strategic Commit Type Selection

### Want to Trigger a Release?

Use one of these types:
- `feat:` - For new features
- `fix:` - For bug fixes
- `fix: refactor ...` - For refactoring that should trigger a release

### Don't Want to Trigger a Release?

Use one of these types:
- `docs:` - Documentation updates
- `refactor:` - Code improvements
- `test:` - Test changes
- `chore:` - Build/tool updates
- `ci:` - CI/CD changes

## Special Case: Refactoring

**Problem:** Refactoring improves code quality but doesn't trigger releases with `refactor:` type.

**Solution:** If the refactoring is significant and should be released:
```
fix: refactor authentication logic for better maintainability
```

This is acceptable because:
- Refactoring often fixes technical debt
- Improves code quality and maintainability
- Makes the codebase more reliable
- Should be included in the next release

## Multiple Commits in One PR

release-please analyzes ALL commits in the PR. The highest-priority type determines the version bump:

**Example PR with multiple commits:**
```
docs: update readme
test: add unit tests
feat: add dark mode
fix: resolve button styling
```

**Result:** MINOR release (1.3.0) - because `feat:` is present

**Priority order:** BREAKING > feat > fix/deps > others

## Breaking Changes

Breaking changes ALWAYS trigger a MAJOR release, regardless of the commit type:

### Method 1: Add `!` after type
```
feat!: change api response format

The API now returns {data, metadata} instead of raw data.
Users need to update their API clients.
```

### Method 2: Add `BREAKING CHANGE:` footer
```
refactor: restructure database schema

BREAKING CHANGE: User table column names have changed.
Migration script required: npm run migrate:v2
```

### When to Use Breaking Changes

Only use breaking changes when:
- Removing public APIs or endpoints
- Changing function signatures
- Modifying data formats
- Requiring migration steps
- Changing default behavior in incompatible ways

## Practical Examples

### Scenario 1: Feature Development

You're adding a new dashboard widget.

**Commit:**
```
feat: add analytics dashboard widget
```

**Result:** MINOR release (1.2.0 → 1.3.0)

---

### Scenario 2: Bug Fix

You're fixing a broken form validation.

**Commit:**
```
fix: correct email validation regex
```

**Result:** PATCH release (1.2.0 → 1.2.1)

---

### Scenario 3: Documentation Update

You're updating the README.

**Commit:**
```
docs: add deployment instructions
```

**Result:** NO release (appears in next release's changelog)

---

### Scenario 4: Refactoring (Want Release)

You're refactoring authentication code and want it released.

**Commit:**
```
fix: refactor authentication flow for improved security
```

**Result:** PATCH release (1.2.0 → 1.2.1)

---

### Scenario 5: Refactoring (No Release Needed)

You're renaming variables for clarity.

**Commit:**
```
refactor: rename user variables for consistency
```

**Result:** NO release (appears in next release's changelog)

---

### Scenario 6: Breaking Change

You're changing the API response format.

**Commit:**
```
feat!: restructure api response format

BREAKING CHANGE: All API endpoints now return {success, data, error}
format instead of direct data. Update client code accordingly.
```

**Result:** MAJOR release (1.2.0 → 2.0.0)

## FAQ

**Q: I made a refactor. Should I use `fix:` or `refactor:`?**

A: Depends on whether you want a release:
- Want release → `fix: refactor ...`
- Don't need immediate release → `refactor: ...`

**Q: Can I combine multiple types in one commit?**

A: No. One commit should have one type. If you have multiple unrelated changes, make multiple commits.

**Q: What if I accidentally use the wrong type?**

A: Before pushing:
- Use `git commit --amend` to fix the message
- After pushing to PR: Add a new commit with the correct type (release-please will use the highest priority)

**Q: Do I need to manually create releases?**

A: No. release-please creates a release PR automatically. Just review and merge it.

## Best Practices

1. **Be intentional** about commit types - they control releases
2. **Use `feat:` and `fix:`** when you want a release
3. **Use `docs:`, `refactor:`, etc.** when you don't need immediate release
4. **Group related changes** into atomic commits
5. **Think about semver** - does this change API contracts?
6. **Review the release PR** before merging to verify changelog
