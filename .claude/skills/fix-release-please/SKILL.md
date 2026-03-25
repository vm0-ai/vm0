---
name: fix-release-please
description: Fix bugs in the forked release-please ecosystem (vm0-ai/release-please + vm0-ai/release-please-action)
context: fork
---

Fix a bug in the project's forked release-please core library, then rebuild the GitHub Action.

## Background

| Repo | Fork of | Branch | Role |
|------|---------|--------|------|
| `vm0-ai/release-please` | `googleapis/release-please` | `vm0` | Core library (TypeScript/Node) |
| `vm0-ai/release-please-action` | `googleapis/release-please-action` | `vm0` | GitHub Action wrapping the core library |

- `.github/workflows/release-please.yml` uses `vm0-ai/release-please-action@vm0`
- The action's `package.json` has `"release-please": "github:vm0-ai/release-please#vm0"`
- Bugs are almost always in the core library, not the action

## Args

Your args are: `$ARGUMENTS`

Parse the args to understand what bug to fix. If no args provided, ask the user what the issue is.

## Workflow

### Step 1: Clone both repos

```bash
cd /tmp && rm -rf release-please release-please-action
git clone https://github.com/vm0-ai/release-please.git
git clone https://github.com/vm0-ai/release-please-action.git
cd /tmp/release-please && git config user.email "noreply@vm0.ai" && git config user.name "vm0-ai"
cd /tmp/release-please-action && git config user.email "noreply@vm0.ai" && git config user.name "vm0-ai"
```

### Step 2: Fix in release-please core

Create a fix branch from `main`, make the fix, then cherry-pick to `vm0`:

```bash
cd /tmp/release-please
git checkout main
git checkout -b fix/<description>
# ... make the fix, write tests to verify, commit ...
git push origin fix/<description>
git checkout vm0
git cherry-pick <commit-sha>
git push origin vm0
```

### Step 3: Rebuild release-please-action

This step is **always required** after any core library change:

```bash
cd /tmp/release-please-action
git checkout vm0
npm install
npm run build
git add package-lock.json dist/index.js
git commit -m "fix: <same description as the core fix>"
git push origin vm0
```

### Step 4: Verify

```bash
cd /tmp/release-please && git log --oneline vm0 -5
cd /tmp/release-please-action && git log --oneline vm0 -5
```

Report what was changed.

## Syncing upstream

If the user asks to sync with upstream:

```bash
cd /tmp/release-please
git remote add upstream https://github.com/googleapis/release-please.git
git fetch upstream
git checkout vm0
git rebase upstream/main
# Resolve conflicts if any
git push origin vm0 --force-with-lease
```

Then rebuild the action (Step 3).
