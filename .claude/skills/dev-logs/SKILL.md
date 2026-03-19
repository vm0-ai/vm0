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

### Step 1: Find the Dev Server Task

First, try to read the persisted task ID from the local file:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cat "$PROJECT_ROOT/turbo/.dev-task-id" 2>/dev/null
```

If the file exists and contains a task ID, use that ID directly.

If the file does not exist, fall back to **TaskList** to find the dev server background task. Look for a task whose command contains `pnpm dev` — this is the task created by `/dev-start`.

If neither method finds a task, inform the user:
- "No dev server task found. Please run `/dev-start` to start the server."

### Step 2: Read Task Output

Use **TaskOutput** with the task_id from Step 1 to read the dev server logs. Use `block: false` to avoid waiting.

### Step 3: Display Output

Show the output in readable format. If a filter pattern was provided, grep the output for matching lines.
