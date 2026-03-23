---
name: begin-coding-loop
description: Start an adaptive coding loop that dynamically adjusts interval based on activity — short intervals when busy, longer when idle.
---

1. Run `scripts/coding-loop.sh ${ARGUMENTS:-$(hostname)}` and capture the stdout.
2. Parse the first line `INTERVAL:N` and save N.
3. If the remaining output (after the first line) is "idle", use CronCreate (one-shot) to schedule `/begin-coding-loop $ARGUMENTS` in N minutes immediately.
4. If the remaining output is NOT "idle", launch a **general-purpose Agent** (subagent) with that output as the prompt. Do NOT execute the instructions yourself — always delegate to a subagent. **Wait for the subagent to complete**, then use CronCreate (one-shot) to schedule `/begin-coding-loop $ARGUMENTS` in N minutes.
