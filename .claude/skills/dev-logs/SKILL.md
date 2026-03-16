---
name: dev-logs
description: View development server logs with optional filtering
---

View development server output by reading the background task output via TaskOutput.

## Arguments Format

Your args are: `$ARGUMENTS`

- _(empty)_ - Show recent output from the dev server
- `[pattern]` - Show only lines matching the regex pattern

## Examples

- `/dev-logs` - Show recent dev server output
- `/dev-logs error` - Show only error messages
- `/dev-logs "compiled|ready"` - Show compilation status

## Workflow

### Step 1: Check Dev Server is Running

```bash
curl -k -s --connect-timeout 3 https://www.vm7.ai:8443/ > /dev/null 2>&1 && echo "✅ Dev server is running" || echo "❌ Dev server is not running. Please run /dev-start first."
```

### Step 2: Read Background Task Output

Use TaskOutput to read the dev server's background task output. The task_id comes from the `run_in_background` Bash call that started the server.

If no task_id is available (e.g., server was started in a previous conversation), inform the user that logs are only available within the same session that started the server.

### Step 3: Display Output

Show the output in readable format. If a filter pattern was provided, grep the output for matching lines.

## Notes

- Dev server logs are only accessible via TaskOutput within the same session
- For persistent logs, check individual service outputs or use the Turbo TUI
