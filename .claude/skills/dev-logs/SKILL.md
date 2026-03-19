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

Use **TaskList** to find the dev server background task. Look for a task whose command contains `pnpm dev` — this is the task created by `/dev-start`.

This approach survives conversation compaction, since TaskList always reflects the current task state regardless of whether the original task_id was preserved in the summary.

If no matching task is found, inform the user:
- "No dev server background task found in this session. Please run `/dev-start` to start the server."

### Step 2: Read Task Output

Use **TaskOutput** with the task_id from Step 1 to read the dev server logs.

### Step 2: Display Output

Show the output in readable format. If a filter pattern was provided, grep the output for matching lines.
