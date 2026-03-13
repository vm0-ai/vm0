---
name: dev-logs
description: View development server logs with optional filtering
---

View development server output logs with optional filtering. Logs are persisted to `/tmp/dev-server.log` via `tee` in the `pnpm dev` script.

## Arguments Format

Your args are: `$ARGUMENTS`

- _(empty)_ - Show recent logs (last 50 lines)
- `[pattern]` - Show only logs matching the regex pattern

## Examples

- `/dev-logs` - Show last 50 lines
- `/dev-logs error` - Show only error messages
- `/dev-logs "web|workspace"` - Show logs from web or workspace packages
- `/dev-logs "compiled|ready"` - Show compilation status

## Workflow

### Step 1: Check Log File Exists

```bash
if [ ! -f /tmp/dev-server.log ]; then
  echo "No dev server log found at /tmp/dev-server.log"
  echo "Please run /dev-start first."
  exit 1
fi
```

### Step 2: Read Logs

**If no filter pattern provided** — show last 50 lines:
```bash
tail -50 /tmp/dev-server.log
```

**If filter pattern provided** — grep matching lines:
```bash
grep -E "<pattern>" /tmp/dev-server.log | tail -50
```

### Step 3: Display Logs

Show the output in readable format. If the log file is empty, mention that no logs have been recorded yet.

## Notes

- Logs are written to `/tmp/dev-server.log` by `pnpm dev` (via `tee`)
- Filter parameter uses regex patterns
- Log file persists across dev server restarts (overwritten on each start)
