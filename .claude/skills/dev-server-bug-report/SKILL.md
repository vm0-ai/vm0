---
name: dev-server-bug-report
description: Analyze conversation history for dev server errors and create a structured GitHub bug report
context: main
---

# Dev Server Bug Report

You are a dev server diagnostics specialist. Your role is to analyze the current conversation history for dev server operation failures and create a structured GitHub issue.

## Arguments

Your args are: `$ARGUMENTS`

Optional arguments can provide additional context about what went wrong (e.g., "pnpm dev won't start", "health check failing").

---

## Phase 1: Insight (Analyze Conversation History)

Scan the current conversation for traces of the following 7 dev server operations and capture any errors encountered.

### Operations to Check

| Operation | What to look for |
|-----------|-----------------|
| `pnpm dev` startup | `cd turbo && pnpm dev` via `run_in_background`, build failures, port conflicts, missing deps |
| Health check | `pnpm dev:status`, curl to `https://www.vm7.ai:8443` / `app.vm7.ai:8443` / `docs.vm7.ai:8443` |
| Database migration | `pnpm db:migrate` (Drizzle ORM + PostgreSQL), connection failures, migration errors |
| Log viewing | `TaskOutput` reads, `/dev-logs` invocations, runtime errors in output |
| SSL certificates | Caddy auto-provisions via Let's Encrypt DNS-01 challenge, requires `CF_DNS_AND_TUNNEL_API_TOKEN` |
| Chrome/VNC | `scripts/start-vnc.sh` (Xvfb + openbox + x11vnc + noVNC + Chrome CDP:9222), crashes, CDP unreachable |
| Agent-Browser | `agent-browser open/snapshot/click`, `agent-browser.json` config, CDP connection failures, timeouts |

### What to Capture

For each operation found in the conversation:

1. **Status**: succeeded, failed, or not attempted
2. **Error messages**: exact error text, stack traces, exit codes
3. **Context**: what was happening before/after the error
4. **Attempted fixes**: any retries or workarounds tried in the conversation

---

## Phase 2: Create Issue

Synthesize findings into a structured GitHub issue.

### Title Format

```
bug: [concise description of the dev server problem]
```

Use lowercase after `bug:`, no period at end. Keep under 100 characters.

### Body Structure

Organize the issue body with the following sections:

```markdown
## Environment

- Container/Host: [hostname or container ID if available]
- Branch: [git branch from conversation context]
- Date: [current date]

## Summary

[1-2 sentence description of the overall problem]

## Operations Attempted

| Operation | Status | Notes |
|-----------|--------|-------|
| pnpm dev startup | [pass/fail/skipped] | [brief note] |
| Health check | [pass/fail/skipped] | [brief note] |
| Database migration | [pass/fail/skipped] | [brief note] |
| Log viewing | [pass/fail/skipped] | [brief note] |
| SSL certificates | [pass/fail/skipped] | [brief note] |
| Chrome/VNC | [pass/fail/skipped] | [brief note] |
| Agent-Browser | [pass/fail/skipped] | [brief note] |

## Error Details

[For each failed operation, include:]

### [Operation Name]

**Error message:**
```
[exact error output]
```

**Context:** [what was being done when the error occurred]

**Attempted fixes:** [any retries or workarounds from the conversation]

## Reproduction Steps

1. [Step-by-step instructions to reproduce based on conversation]

## Additional Context

[Any other relevant information from the conversation]

---
*Created from conversation context by `/dev-server-bug-report`*
```

### Guidelines

- Include only operations that were actually attempted or relevant to the failure
- Use exact error messages from the conversation, not paraphrased versions
- Omit sections that have no relevant content (e.g., skip "Attempted fixes" if none were tried)
- Keep the summary focused on the root cause if identifiable

---

## Phase 3: Assign and Create

Create the issue with hardcoded assignee `e7h4n`:

```bash
gh issue create \
  --title "bug: [description]" \
  --body "[synthesized body]" \
  --assignee e7h4n
```

### Display Result

After creation, display the issue URL:

```
Bug report created: https://github.com/vm0-ai/vm0/issues/<number>
```
