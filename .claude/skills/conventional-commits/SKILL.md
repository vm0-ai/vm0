---
name: Conventional Commits
description: Guidelines for writing conventional commit messages that follow project standards and trigger automated releases
---

# Conventional Commits Skill

This skill provides comprehensive guidance on writing conventional commit messages for the vm0 project. All commits must follow the Conventional Commits format to ensure consistent history and enable automated versioning via release-please.

## Quick Reference

### Format
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Core Rules (STRICT REQUIREMENTS)

1. **Type must be lowercase** - `feat:` not `Feat:` or `FEAT:`
2. **Description must start with lowercase** - `add feature` not `Add feature`
3. **No period at the end** - `fix user login` not `fix user login.`
4. **Keep title under 100 characters** - Be concise
5. **Use imperative mood** - `add` not `added` or `adds`

## Common Types (Quick List)

| Type | Purpose | Release? |
|------|---------|----------|
| `feat:` | New feature | ✅ Minor bump |
| `fix:` | Bug fix | ✅ Patch bump |
| `docs:` | Documentation | ❌ No release |
| `refactor:` | Code refactoring | ❌ No release |
| `test:` | Tests | ❌ No release |
| `chore:` | Build/tools | ❌ No release |

**Pro tip:** If you want a `refactor` to trigger a release, use `fix: refactor ...` instead.

## When to Load Additional Context

- **Need detailed type definitions?** → Read `types.md`
- **Confused about what triggers releases?** → Read `release-triggers.md`
- **Want to see good and bad examples?** → Read `examples.md`

## Quick Validation Checklist

Before committing, verify:
- ✅ Type is lowercase and valid
- ✅ Description starts with lowercase
- ✅ No period at the end
- ✅ Under 100 characters
- ✅ Imperative mood (add, fix, update)
- ✅ Accurately describes the "why" not just the "what"

## Special Rules for Documentation App

Changes to `turbo/apps/docs` should use `feat(docs):` or `fix(docs):` instead of `docs(...):`

**Why?** The `turbo/apps/docs` directory IS the documentation application. Updates to it are features/fixes to the docs product, not just documentation changes to code. Using `feat(docs)` or `fix(docs)` triggers a proper release.

| Change Type | Commit Type | Example |
|-------------|-------------|---------|
| Add new docs page | `feat(docs):` | `feat(docs): add codex provider documentation` |
| Fix broken link | `fix(docs):` | `fix(docs): correct model selection link path` |
| Update content | `feat(docs):` | `feat(docs): update quick start instructions` |

❌ `docs: add integration guide` (won't trigger release)
✅ `feat(docs): add integration guide` (triggers release)

## Common Mistakes to Avoid

❌ `Fix: Resolve database connection timeout.` (capitalized type, has period)
❌ `added user auth` (missing type, wrong tense)
❌ `feat: Add user authentication system with OAuth2...` (capitalized description, too long)
❌ `docs: update quick start` (for turbo/apps/docs changes - use feat(docs) instead)

✅ `fix: resolve database connection timeout`
✅ `feat: add user authentication`
✅ `docs(api): update endpoint documentation` (for inline code docs, not turbo/apps/docs)
✅ `feat(docs): add new integration page` (for turbo/apps/docs changes)

## Integration with Workflow

This skill should be triggered whenever:
1. Creating a commit message
2. Validating an existing commit message
3. Planning what changes should go into a single commit
4. Deciding if changes should trigger a release

The commit message should focus on **why** the change was made, not **what** was changed (git diff shows the what).
