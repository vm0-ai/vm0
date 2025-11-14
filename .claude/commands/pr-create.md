# Git Commit and PR Workflow

> **⚠️ DEPRECATED**: This command is being superseded by the **pr-creator agent** which provides automated quality checks, branch management, and PR creation. Consider using the agent for a more robust workflow.
>
> To use the new agent-based approach, simply describe what you want to commit and let the pr-creator agent handle the workflow automatically.

This document describes the standard workflow for committing changes and creating pull requests.

## Prerequisites
- GitHub CLI (`gh`) must be installed
- Must be authenticated with GitHub (`gh auth login`)

## Workflow Steps

### 1. Check Current Branch
First, check which branch you're currently on:
```bash
git branch --show-current
```

### 2. Branch Strategy
- **If on `main`**: Create a new feature branch
- **If on feature branch**: Continue with current branch

### 3. Create Feature Branch (if on main)
```bash
# Create descriptive branch name
# Format: type/short-description
# Examples: fix/typescript-errors, feat/add-cli-command, docs/update-readme
git checkout -b <branch-name>
```

### 4. Stage, Commit and Push Changes
```bash
# Check status
git status

# Stage all changes
git add -A

# Commit with conventional commit message
git commit -m "<type>: <description>"

# Push to remote (use -u flag if new branch)
git push  # or git push -u origin <branch-name> for new branches

# Display PR link
gh pr view --json url -q .url
```

#### Commit Message Format (Conventional Commits)
Must follow the format: `<type>[optional scope]: <description>`

**Types** (required):
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, semicolons, etc)
- `refactor:` Code refactoring
- `test:` Test additions or changes
- `chore:` Build process or auxiliary tool changes
- `ci:` CI configuration changes
- `perf:` Performance improvements
- `build:` Build system changes
- `revert:` Revert previous commit

**Rules**:
- Use lowercase for type
- Description must start with lowercase
- No period at the end
- Keep under 100 characters

**Examples**:
- ✅ `fix: resolve TypeScript Worker type error`
- ✅ `feat(cli): add new command for initialization`
- ❌ `Fix: Resolve TypeScript Worker type error.` (wrong case, has period)
- ❌ `fixed TypeScript errors` (missing type)

### 5. Create Pull Request (for new branches)
If you created a new branch, create a PR immediately:
```bash
# Simple PR with just a title (body will be auto-generated from commits)
gh pr create --title "<type>: <description>"

# Or with a brief description
gh pr create --title "<type>: <description>" --body "Brief description of what this PR does"
```

### 6. Get PR Link
After creating or updating a PR, get the link:
```bash
# Get PR URL for the current branch
gh pr view --json url -q .url

# Or open PR in browser
gh pr view --web
```

## Complete Example

### Scenario 1: Starting from main branch
```bash
# Check current branch
git branch --show-current
# Output: main

# Create feature branch
git checkout -b fix/typescript-worker-error

# Make changes, then commit
git add -A
git commit -m "fix: resolve TypeScript Worker type error in CLI package"
git push -u origin fix/typescript-worker-error

# Create PR
gh pr create --title "fix: resolve TypeScript Worker type error in CLI package"

# Get PR link
gh pr view --json url -q .url
```

### Scenario 2: Already on feature branch
```bash
# Check current branch
git branch --show-current
# Output: fix/typescript-worker-error

# Make changes, then commit
git add -A
git commit -m "fix: update tsconfig to handle vitest dependencies"

# Push to existing branch
git push

# Get PR link
gh pr view --json url -q .url
```

## Tips
1. Always create branches from an up-to-date `main`:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b <new-branch>
   ```

2. Keep commits focused and atomic

3. Use descriptive branch names that match the PR title

4. For complex changes, update the PR description after pushing:
   ```bash
   gh pr edit <pr-number> --body "Updated description..."
   ```

5. View PR status:
   ```bash
   gh pr checks
   gh pr status
   ```