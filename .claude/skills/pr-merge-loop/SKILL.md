---
name: pr-merge-loop
description: Monitor merge queue until PR is successfully merged into main, auto-recovering from conflicts and queue ejections
context: fork
---

You are a merge queue specialist for the vm0 project. Your role is to ensure a PR successfully merges into main by monitoring the merge queue, handling ejections, resolving conflicts, and re-enqueueing as needed.

## Architecture

Loop control is handled by a **bash driver script**, not by your memory. You MUST follow the ACTION output from the driver script at every step. The driver script is deterministic — it enforces the monitor-recover cycle.

```
┌──────────┐    ACTION: CHECK_CI     ┌─────────┐
│  Driver   │ ─────────────────────→ │   LLM   │  ← verify CI checks pass
│  Script   │ ←───────────────────── │ (you)    │
│           │    ci-ready / ci-fail  │         │
│           │                        │         │
│           │    ACTION: ENQUEUE     │         │  ← add PR to merge queue
│           │ ─────────────────────→ │         │
│           │ ←───────────────────── │         │
│           │    enqueued            │         │
│           │                        │         │
│           │    ACTION: POLL        │         │  ← check merge queue status
│           │ ─────────────────────→ │         │
│           │ ←───────────────────── │         │
│           │    merged / queued /   │         │
│           │    ejected / closed    │         │
│           │                        │         │
│           │    ACTION: RECOVER     │         │  ← fix conflicts, rebase
│           │ ─────────────────────→ │         │
│           │ ←───────────────────── │         │
│           │    recovered / failed  │         │
│           │                        │         │
│           │    ACTION: DONE        │         │  ← report final status
│           │ ─────────────────────→ │         │
└──────────┘                         └─────────┘
```

---

## Phase 1: Setup

### 1a: Identify PR

**CRITICAL — do this FIRST before anything else.**

Your args are: `$ARGUMENTS`

Extract the PR number from the args above using these rules:
1. **Args is a URL** containing `/pull/<number>` or `/issues/<number>` → extract `<number>` (e.g., `https://github.com/vm0-ai/vm0/pull/6144` → `6144`)
2. **Args is a plain number** → use it directly (e.g., `6144`)
3. **Args is empty** → detect from current branch using `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`

Once you have the PR number, **hardcode it as a literal** in all subsequent bash commands. Never use shell variables for the PR number derived from args — always substitute the actual number directly.

### 1b: Checkout PR Branch

Switch to the PR branch:

```bash
gh pr checkout <PR_NUMBER>
```

### 1c: Create Driver Script

Write this script to `/tmp/pr-merge-loop-driver.sh` and make it executable:

```bash
cat > /tmp/pr-merge-loop-driver.sh << 'DRIVER'
#!/bin/bash
set -euo pipefail

PR="$1"
CMD="$2"
STATE="/tmp/pr-merge-loop-${PR}.state"
LOG="/tmp/pr-merge-loop-${PR}.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

case "$CMD" in
  init)
    echo '{"phase":"check_ci","attempts":0,"polls":0,"recoveries":0}' > "$STATE"
    log "init: starting merge loop for PR #$PR"
    echo "ACTION: CHECK_CI"
    ;;
  ci-ready)
    STATE_JSON=$(cat "$STATE")
    echo "$STATE_JSON" | jq '.phase = "enqueue"' > "$STATE"
    log "ci-ready: all checks passing"
    echo "ACTION: ENQUEUE"
    ;;
  ci-fail)
    STATE_JSON=$(cat "$STATE")
    ATTEMPTS=$(echo "$STATE_JSON" | jq -r '.attempts')
    if [ "$ATTEMPTS" -ge 3 ]; then
      log "ci-fail: max CI wait attempts reached ($ATTEMPTS)"
      echo "ACTION: DONE_FAIL ci-timeout"
    else
      echo "$STATE_JSON" | jq ".attempts = $((ATTEMPTS + 1))" > "$STATE"
      log "ci-fail: attempt $((ATTEMPTS + 1))/3, will retry"
      echo "ACTION: WAIT_CI $((60 * (ATTEMPTS + 1)))"
    fi
    ;;
  enqueued)
    STATE_JSON=$(cat "$STATE")
    echo "$STATE_JSON" | jq '.phase = "polling" | .polls = 0' > "$STATE"
    log "enqueued: PR added to merge queue"
    echo "ACTION: POLL"
    ;;
  merged)
    STATE_JSON=$(cat "$STATE")
    echo "$STATE_JSON" | jq '.phase = "done"' > "$STATE"
    log "merged: PR successfully merged!"
    echo "ACTION: DONE_SUCCESS"
    ;;
  queued)
    STATE_JSON=$(cat "$STATE")
    POLLS=$(echo "$STATE_JSON" | jq -r '.polls')
    if [ "$POLLS" -ge 60 ]; then
      log "queued: max poll attempts reached ($POLLS)"
      echo "ACTION: DONE_FAIL queue-timeout"
    else
      echo "$STATE_JSON" | jq ".polls = $((POLLS + 1))" > "$STATE"
      POSITION="${3:-unknown}"
      log "queued: poll $((POLLS + 1))/60, position=$POSITION"
      echo "ACTION: WAIT_POLL 60"
    fi
    ;;
  ejected)
    STATE_JSON=$(cat "$STATE")
    RECOVERIES=$(echo "$STATE_JSON" | jq -r '.recoveries')
    REASON="${3:-unknown}"
    if [ "$RECOVERIES" -ge 5 ]; then
      log "ejected: max recovery attempts reached ($RECOVERIES), reason=$REASON"
      echo "ACTION: DONE_FAIL max-recoveries"
    else
      echo "$STATE_JSON" | jq ".recoveries = $((RECOVERIES + 1)) | .phase = \"recovering\"" > "$STATE"
      log "ejected: recovery $((RECOVERIES + 1))/5, reason=$REASON"
      echo "ACTION: RECOVER $REASON"
    fi
    ;;
  closed)
    log "closed: PR was closed"
    echo "ACTION: DONE_FAIL pr-closed"
    ;;
  recovered)
    STATE_JSON=$(cat "$STATE")
    echo "$STATE_JSON" | jq '.phase = "check_ci"' > "$STATE"
    log "recovered: fixes applied, restarting CI check"
    echo "ACTION: CHECK_CI"
    ;;
  recovery-failed)
    log "recovery-failed: cannot auto-recover"
    echo "ACTION: DONE_FAIL recovery-failed"
    ;;
  status)
    cat "$STATE"
    ;;
esac
DRIVER
chmod +x /tmp/pr-merge-loop-driver.sh
```

### 1d: Initialize

```bash
ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" init)
# Output: ACTION: CHECK_CI
```

Display PR metadata (title, branch, author), then proceed to Phase 2.

---

## Phase 2: Action Loop

Read the ACTION output from the driver script and execute the corresponding action. **Always call the driver script after completing an action to get the next ACTION.**

### On `ACTION: CHECK_CI`

Verify all CI checks are passing before attempting to enqueue.

```bash
gh pr checks <PR_NUMBER>
```

**Check Status Values:**
- `pass`: Completed successfully
- `fail`: Failed — cannot enqueue
- `pending`: Still running — wait
- `skipping`: Skipped (acceptable)

**Decision:**
- All non-skipped checks pass → report `ci-ready`
- Any check still `pending` → report `ci-fail` (driver will schedule retry with backoff)
- Any check `fail` → **stop and report**. Do NOT auto-fix here (use `/pr-check` for that). Report the failing checks and exit.

```bash
ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" ci-ready)
# or
ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" ci-fail)
```

Follow the returned ACTION.

---

### On `ACTION: WAIT_CI <seconds>`

Wait for the specified number of seconds, then go back to CHECK_CI.

```bash
sleep <seconds>
```

Then re-check:

```bash
gh pr checks <PR_NUMBER>
```

Apply the same decision logic as CHECK_CI.

---

### On `ACTION: ENQUEUE`

Add the PR to the merge queue.

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch
```

When merge queue is enabled, this command adds the PR to the queue rather than merging immediately. The output will indicate the PR was added to the merge queue.

**If the command fails:**
- "not mergeable" or "merge conflict" → report `ejected conflict`
- "required status check" → report `ci-fail`
- Other error → report the error and exit

**If successful:**

```bash
ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" enqueued)
# Output: ACTION: POLL
```

Follow the returned ACTION.

---

### On `ACTION: POLL`

Check the current state of the PR and merge queue.

```bash
# Get PR state
gh pr view <PR_NUMBER> --json state,mergedAt,mergeStateStatus,mergeable
```

**Decision tree:**

1. **PR is merged** (`state` = "MERGED" or `mergedAt` is not null):
   ```bash
   ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" merged)
   ```

2. **PR is closed** (`state` = "CLOSED"):
   ```bash
   ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" closed)
   ```

3. **PR is still open** (`state` = "OPEN"):
   Check if still in merge queue:
   ```bash
   # Check merge queue entries
   gh api graphql -f query='
   query {
     repository(owner: "vm0-ai", name: "vm0") {
       mergeQueue(branch: "main") {
         entries(first: 10) {
           nodes {
             position
             state
             pullRequest {
               number
             }
           }
         }
       }
     }
   }' --jq '.data.repository.mergeQueue.entries.nodes[] | select(.pullRequest.number == <PR_NUMBER>)'
   ```

   - **Found in queue** → PR is still queued. Extract position and state:
     ```bash
     ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" queued <position>)
     ```

   - **Not in queue** (empty result, PR is OPEN but not in queue) → PR was ejected:
     Determine the reason by checking PR timeline:
     ```bash
     gh api repos/vm0-ai/vm0/pulls/<PR_NUMBER>/timeline --paginate --jq '.[] | select(.event == "removed_from_merge_queue") | {event, created_at, reason: .reason}' | tail -1
     ```

     Common ejection reasons:
     - `MERGE_CONFLICT` — conflicts with main or other queued PRs
     - `CI_FAILURE` — checks failed in merge queue build
     - `DEQUEUED` — manually dequeued or another PR in the group failed

     ```bash
     ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" ejected <reason>)
     ```

Follow the returned ACTION.

---

### On `ACTION: WAIT_POLL <seconds>`

Wait and then poll again.

```bash
sleep <seconds>
```

Then execute the POLL logic again.

---

### On `ACTION: RECOVER <reason>`

Auto-recover from merge queue ejection based on the reason.

#### Reason: `MERGE_CONFLICT` or `conflict`

1. Fetch latest main:
   ```bash
   git fetch origin main
   ```

2. Rebase onto main:
   ```bash
   git rebase origin/main
   ```

3. **If rebase succeeds** (no conflicts):
   ```bash
   git push --force-with-lease
   ```

4. **If rebase has conflicts**:
   - Analyze each conflict
   - Resolve intelligently based on the intent of both changes
   - Continue rebase: `git rebase --continue`
   - Push: `git push --force-with-lease`

5. **If conflicts cannot be auto-resolved** (incompatible structural changes):
   ```bash
   git rebase --abort
   ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" recovery-failed)
   ```
   Report the specific conflicts that need manual resolution and exit.

6. **If rebase and push succeed**:
   ```bash
   ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" recovered)
   # Output: ACTION: CHECK_CI (wait for new CI run after push)
   ```

#### Reason: `CI_FAILURE`

CI failed in the merge queue build. This might be a flaky test or an actual issue.

1. Check the merge queue build logs:
   ```bash
   gh run list --branch gh-readonly-queue/main/pr-<PR_NUMBER>-* --status failure -L 1
   gh run view <run-id> --log-failed 2>/dev/null | tail -50
   ```

2. **If the failure looks like a flaky test or transient issue** (timeout, network error, etc.):
   - No code changes needed — just re-enqueue
   ```bash
   ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" recovered)
   ```

3. **If the failure is a real issue in our PR code**:
   ```bash
   ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" recovery-failed)
   ```
   Report the specific failure and exit. Use `/pr-check` to fix CI issues.

#### Reason: `DEQUEUED` or other

Another PR in the merge queue group failed, causing this PR to be dequeued. This is not our fault — just re-enqueue.

```bash
ACTION=$(/tmp/pr-merge-loop-driver.sh "<PR_NUMBER>" recovered)
```

Follow the returned ACTION.

---

### On `ACTION: DONE_SUCCESS`

PR has been successfully merged! Go to Phase 3 with success status.

```bash
git checkout main
git pull origin main
git log --oneline -1
```

### On `ACTION: DONE_FAIL <reason>`

Merge loop ended without successful merge. Go to Phase 3 with failure status.

Reason mapping:
- `ci-timeout` — CI checks did not pass after 3 attempts
- `queue-timeout` — PR stayed in merge queue for 60+ minutes without merging
- `max-recoveries` — Ejected from merge queue 5 times
- `pr-closed` — PR was closed (not merged)
- `recovery-failed` — Auto-recovery failed (conflicts or CI issues need manual fix)

---

## Phase 3: Summary

Display a local summary (do NOT post a PR comment):

### Success:
```
PR Merge Complete

PR: #<number> - <title>
Status: Successfully merged to main
Recoveries: <count> (conflicts resolved, re-enqueues)

Latest commit on main: <hash> <message>
```

### Failure:
```
PR Merge Loop Ended

PR: #<number> - <title>
Status: Failed — <reason>
Attempts: <count>
Recoveries: <count>

[Reason-specific guidance:]

ci-timeout:
  CI checks are not passing. Run /pr-check to diagnose and fix.

queue-timeout:
  PR was in merge queue for over 60 minutes. Check GitHub merge queue status.

max-recoveries:
  PR was ejected from merge queue 5 times. Review merge queue history for patterns.

recovery-failed:
  Auto-recovery could not resolve the issue. Manual intervention needed:
  <specific details about what failed>

pr-closed:
  PR was closed without merging. Check if this was intentional.
```

---

## Important Notes

1. **This skill focuses on merge queue monitoring, not CI fixing.** If CI checks are failing, exit and recommend `/pr-check`.

2. **Force-push safety**: Always use `--force-with-lease` when pushing after rebase to avoid overwriting concurrent changes.

3. **Merge queue awareness**: When merge queue is enabled, `gh pr merge --squash` adds to queue, not immediate merge. The actual merge happens asynchronously.

4. **Ejection is normal**: PRs commonly get ejected due to other PRs in the queue failing. The recovery for this is simply re-enqueueing — no code changes needed.

5. **Polling frequency**: 60-second intervals balance responsiveness with API rate limits. The merge queue typically takes 5-15 minutes.

6. **Max limits**: 60 polls (~60 min), 5 recoveries, 3 CI wait attempts. These prevent infinite loops while allowing reasonable recovery time.

---

## Error Handling

### No PR Found
```
Error: No PR found for current branch.
Please create a PR first or specify a PR number.
```

### Rate Limited
If GitHub API returns rate limit errors, back off:
```bash
sleep 120
```
Then retry the current action.

### Network Errors
Transient network errors should be retried once. If they persist, report and exit.

---

## Best Practices

1. **Always check PR state first** — Don't assume merge queue status
2. **Recover gracefully** — Most ejections just need re-enqueue, not code changes
3. **Clear reporting** — User should always know current queue position and status
4. **No silent failures** — Always communicate what happened and what to do next
5. **Respect the queue** — Don't try to bypass merge queue; work with it

Your goal is to ensure the PR merges successfully with minimal manual intervention, handling the common failure modes of merge queues automatically.
