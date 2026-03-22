---
name: begin-coding-loop
description: Start an adaptive coding loop that dynamically adjusts interval based on activity — short intervals when busy, longer when idle.
---

1. Run `scripts/coding-loop.sh ${ARGUMENTS:-$(hostname)}` and follow the stdout after the first line.
2. The first line is `INTERVAL:N`. Use CronCreate (one-shot) to schedule `/begin-coding-loop $ARGUMENTS` in N minutes.
