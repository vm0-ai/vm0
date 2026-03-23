---
name: dev-logs
description: View development server logs with optional filtering
---

View development server output. Uses a persistent log file as the primary source, with TaskOutput as fallback.

## Arguments Format

Your args are: `$ARGUMENTS`

- _(empty)_ - Show recent output from the dev server
- `[pattern]` - Show only lines matching the regex pattern

## Examples

- `/dev-logs` - Show recent dev server output
- `/dev-logs error` - Show only error messages
- `/dev-logs "compiled|ready"` - Show compilation status

## Workflow

### Step 1: Read Logs from File (Primary)

The dev server writes logs to a persistent file via `tee`. Read from it:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
tail -n 200 "$PROJECT_ROOT/turbo/.dev-server.log" 2>/dev/null
```

If the file exists and has content, use this output — proceed to Step 3.

If the file does not exist or is empty, fall back to Step 2.

### Step 2: Fallback — TaskOutput

Try to read the task ID from the persisted file:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cat "$PROJECT_ROOT/turbo/.dev-task-id" 2>/dev/null
```

If the file exists and contains a task ID, use **TaskOutput** with that ID (`block: false`) to read the dev server logs.

If the file does not exist, fall back to **TaskList** to find a task whose command contains `pnpm dev`.

If neither method finds a task, inform the user:
- "No dev server logs found. Please run `/dev-start` to start the server."

### Step 3: Display Output

Show the output in readable format. If a filter pattern was provided in the arguments, filter the output for matching lines only.
