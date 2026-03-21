---
name: begin-coding-loop
description: Start an adaptive coding loop that dynamically adjusts interval based on activity — short intervals when busy, longer when idle.
---

# Begin Coding Loop

Start the autonomous coding loop with adaptive interval timing. The interval dynamically adjusts based on whether the previous round performed meaningful work.

## Arguments

Your args are: `$ARGUMENTS`

The first argument is the **LABEL** — the GitHub label used to filter both PRs and issues.

If no label is provided, use the current machine's hostname:

```bash
LABEL="${1:-$(hostname)}"
```

## Adaptive Interval Logic

The loop uses a state file to track activity and dynamically adjust the interval between rounds.

### State File

```bash
STATE_FILE="/tmp/coding-loop-interval-${LABEL}"
```

The state file stores the current interval in minutes. If it does not exist, initialize it to `1` (start fast).

### Interval Rules

- **If the previous round did work** (merged a PR, fixed CI, resolved conflicts, created a PR, ran a review): reset interval to **1 minute**
- **If the previous round was idle** (nothing to do, waiting for CI, skipped): **double** the current interval, capped at **30 minutes**

### Interval Progression (when idle)

1m -> 2m -> 4m -> 8m -> 16m -> 30m -> 30m -> ...

Any activity resets back to 1m.

## Workflow

### Step 1: Read Current Interval

```bash
LABEL="${ARGUMENTS:-$(hostname)}"
STATE_FILE="/tmp/coding-loop-interval-${LABEL}"

if [ -f "$STATE_FILE" ]; then
  INTERVAL=$(cat "$STATE_FILE")
else
  INTERVAL=1
fi
```

### Step 2: Initialize State File

If starting fresh, write the initial interval:

```bash
echo "1" > "$STATE_FILE"
```

### Step 3: Start the Loop

Invoke the `/loop` skill with the current interval and `/coding-loop`:

```
/loop ${INTERVAL}m /coding-loop ${LABEL}
```

### Step 4: After Each Round — Adjust Interval

After `/coding-loop` completes each round, evaluate what happened:

1. **Check if work was done** — Look at the coding-loop output for indicators:
   - PR merged, conflict resolved, CI fix pushed, code review posted, new PR created, issue implementation started
   - Any of these = **work was done**

2. **Update the interval**:

   ```bash
   if [ "$WORK_DONE" = "true" ]; then
     echo "1" > "$STATE_FILE"
   else
     CURRENT=$(cat "$STATE_FILE")
     NEXT=$((CURRENT * 2))
     if [ "$NEXT" -gt 30 ]; then
       NEXT=30
     fi
     echo "$NEXT" > "$STATE_FILE"
   fi
   ```

3. **Report the interval change** to the user:
   - If reset: "Activity detected — next check in 1m"
   - If increased: "No activity — next check in ${NEXT}m"

## Implementation

When this skill is invoked:

1. Parse the label from arguments (or use hostname as default)
2. Read or initialize the interval state file
3. Start `/loop` with the adaptive interval mechanism

The key insight is that `/loop` runs `/coding-loop` repeatedly. After each invocation of `/coding-loop`, check the output to determine if work was performed, then adjust the interval for the next round.

### Detecting Activity

The coding-loop skill outputs a summary at the end of each round. Look for these signals:

**Work done (reset to 1m):**

- "conflict resolved" / "merge conflict"
- "CI failure" / "fixed" / "pushed"
- "code review" / "P0" / "P1"
- "auto-merge enabled"
- "PR created" / "PR #"
- "implementing" / "issue-action"
- "merged"

**No work (increase interval):**

- "No open PRs" + "No issues"
- "skip flag" + no Phase B work
- "waiting for CI" with review already done
- "nothing to do"
- All PRs already have auto-merge enabled and review done

## Example Usage

```
# Use default label (hostname)
/begin-coding-loop

# Use specific label
/begin-coding-loop api-token-connector
```

## Key Behavior

- Starts checking every 1 minute
- Backs off exponentially when idle (up to 30 min)
- Snaps back to 1 minute as soon as there is work to do
- The state file persists across loop iterations via `/tmp/`
- Each label has its own independent interval state
