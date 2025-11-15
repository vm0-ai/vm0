---
command: dev-stop
description: Stop the background development server
---

Stops the background development server gracefully.

Usage: `/dev-stop`

## What to do:

1. **Find the dev server shell ID:**
   Use `/bashes` command to list all background shells and identify the one running "pnpm dev".

2. **Stop the server:**
   ```javascript
   KillShell({ shell_id: "<shell-id>" })
   ```

3. **Verify it's stopped:**
   ```bash
   pgrep -f "pnpm dev"
   ```

4. **Show appropriate message:**

   If stopped successfully:
   ```
   ✅ Dev server stopped successfully

   You can start it again with `/dev-start`
   ```

   If process still detected:
   ```
   ⚠️ Warning: Dev server process still detected

   Try manual cleanup: pkill -f "pnpm dev"
   ```

   If no dev server was running:
   ```
   ℹ️ No dev server is currently running

   Use `/dev-start` to start one
   ```
