---
name: begin-coding-loop
description: Start an adaptive coding loop that dynamically adjusts interval based on activity — short intervals when busy, longer when idle.
---

1. Run `scripts/coding-loop.sh ${ARGUMENTS:-$(hostname)}` and capture the stdout.
2. Parse the first line `INTERVAL:N` and save N.
3. Use CronList to check if a recurring cron job for `/begin-coding-loop` already exists.
   - If a matching job exists **and** its interval differs from N minutes, delete it with CronDelete and create a new recurring cron with `*/N * * * *` and prompt `/begin-coding-loop $ARGUMENTS`.
   - If a matching job exists **and** its interval already matches N minutes, do nothing (keep it as-is).
   - If no matching job exists, create a new recurring cron with `*/N * * * *` and prompt `/begin-coding-loop $ARGUMENTS`.
4. If the remaining output (after the first line) is "idle", stop here — the recurring cron will trigger the next check.
5. If the remaining output is NOT "idle", launch a **general-purpose Agent** (subagent) with that output as the prompt. Do NOT execute the instructions yourself — always delegate to a subagent. **Wait for the subagent to complete** before returning.
