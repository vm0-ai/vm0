---
command: rebase-main
description: Rebase current branch onto origin/main and resolve conflicts
---

1. Run `git fetch origin main` to get latest main.
2. Run `git rebase origin/main` to rebase current branch.
3. If there are conflicts, resolve them by reading the conflicted files, making the correct edits, then `git add` and `git rebase --continue`. Repeat until rebase completes.
