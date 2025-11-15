---
command: dev-logs
description: View development server logs with optional filtering
---

Views the output from the background development server.

Usage:
- `/dev-logs` - Show all new logs since last check
- `/dev-logs [pattern]` - Show only logs matching the pattern (regex)

Examples:
- `/dev-logs error` - Show only error messages
- `/dev-logs "web|workspace"` - Show logs from web or workspace packages
- `/dev-logs "compiled|ready"` - Show compilation status

## What to do:

1. **Find the dev server shell ID:**
   Use `/bashes` command to list all background shells, or look for the shell running "pnpm dev".

2. **If no filter pattern provided:**
   ```javascript
   BashOutput({ bash_id: "<shell-id>" })
   ```

3. **If filter pattern provided:**
   ```javascript
   BashOutput({ bash_id: "<shell-id>", filter: "<pattern>" })
   ```

4. **Display the logs:**
   Show the output in a readable format. If empty, mention that no new logs since last check.

## Important notes:
- This only shows **NEW** output since the last time logs were checked
- The filter parameter uses regex patterns
- If no dev server is running, show error and suggest using `/dev-start`
