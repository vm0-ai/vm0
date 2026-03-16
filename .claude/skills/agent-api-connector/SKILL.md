---
name: agent-api-connector
description: Process api-token connector issues end-to-end — merge existing PRs first, then implement one new connector
context: fork
---

# Process API-Token Connector

You are an api-token connector lifecycle specialist. Each invocation does TWO phases:
1. **Phase A:** Check and merge existing connector PRs (resolve conflicts, wait for CI, merge when ready)
2. **Phase B:** Implement one new connector (only if no open connector PR exists)

This single-agent design avoids the N! merge conflict problem caused by parallel agents.

---

## Phase A: Check and Merge Existing PRs

Process existing open connector PRs **one at a time, sequentially**.

### Step A0: Sync Main

```bash
rm -f .claude/scheduled_tasks.lock
git checkout main
git stash 2>/dev/null; git pull; git stash pop 2>/dev/null; true
```

### Step A1: List Connector PRs

```bash
gh pr list --state open --json number,title,mergeable,headRefName \
  --jq '.[] | select(.title | test("connector|api.?key|api.?token"; "i")) | {number, title, mergeable}'
```

If no open connector PRs, skip to **Phase B**.

### Step A2: Process Each PR Sequentially

For each PR (one at a time, never parallel):

#### Check Merge Conflict Status

```bash
gh pr view <PR> --json mergeable --jq '.mergeable'
```

#### Case 1: Merge Conflict

1. **Disable auto-merge first** (prevent stale auto-merge from triggering after push):
   ```bash
   gh pr merge --disable-auto <PR>
   ```

2. **Checkout, resolve conflict, push:**
   ```bash
   git checkout <branch>
   git fetch origin main
   git merge origin/main
   # Resolve conflicts in the shared files (connectors.ts, services.ts, provider-registry.ts, connector-icons.tsx, connectorTypeSchema)
   # These are always additive — keep ALL entries from both sides, maintain alphabetical order
   git add <resolved files>
   git commit -m "chore: resolve merge conflict with main"
   git push
   ```

3. **Return to main:**
   ```bash
   rm -f .claude/scheduled_tasks.lock
   git checkout main
   git stash 2>/dev/null; git pull; git stash pop 2>/dev/null; true
   ```

4. **DO NOT merge this PR in this round.** Move to next PR. The pushed conflict resolution needs a fresh CI run.

#### Case 2: No Conflict, CI Failing

1. Check CI status:
   ```bash
   gh pr checks <PR> --json name,state,conclusion
   ```

2. **If runner/e2e failures:** Post to Slack `#dev` channel mentioning `liangyou@vm0.ai` with the failed job URL, then retry:
   ```bash
   gh pr checks <PR> --json name,state,conclusion --jq '.[] | select(.conclusion == "failure")'
   # Retry failed workflows
   ```

3. **If other failures (lint, type, build):** Checkout the branch, fix the code, push. **Do NOT merge this round** — wait for next CI run.

4. Return to main after fixing.

#### Case 3: No Conflict, CI Passing (15+ SUCCESS), No Push This Round → MERGE

1. **Verify CI completion** — at least 15 checks must show SUCCESS. Do not merge if checks are still in_progress:
   ```bash
   gh pr checks <PR> --json name,state,conclusion \
     --jq '[.[] | select(.conclusion == "success")] | length'
   ```

2. **Merge:**
   ```bash
   gh pr merge <PR> --merge --delete-branch
   ```

3. **Pull main** to get the merge:
   ```bash
   rm -f .claude/scheduled_tasks.lock
   git checkout main
   git stash 2>/dev/null; git pull; git stash pop 2>/dev/null; true
   ```

4. Proceed to next PR.

### Step A3: Summary

After processing all PRs, report:
- How many PRs were merged
- How many had conflicts resolved (pending next CI)
- How many had CI failures fixed (pending next CI)
- How many are still waiting for CI

---

## Phase B: Implement New Connector

**Skip Phase B entirely if any open connector PR exists after Phase A.** Only proceed when there are zero open connector PRs.

### Step B1: Find Next Issue

1. List open issues with the `api-token connector` label that have no linked PR:
   ```bash
   gh issue list --repo vm0-ai/vm0 --label "api-token connector" --state open \
     --json number,title,closedByPullRequestsReferences --limit 50
   ```

2. Filter to issues where `closedByPullRequestsReferences` is empty. Pick the lowest issue number.

3. Also check there is no existing open PR for this connector:
   ```bash
   gh api "repos/vm0-ai/vm0/pulls?state=open&per_page=100" --jq '.[].title' | grep -i <connector-name>
   ```

4. If no unlinked issues remain, end.

### Step B2: Research the Connector

In parallel:

1. **Read the skill definition** from `vm0-ai/vm0-skills`:
   ```bash
   gh api "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" --jq '.content' | base64 -d
   ```
   - Note the `vm0_secrets` name — it must follow `XXX_TOKEN` convention per `docs/add-oauth-connector.md`
   - Note the API base URL and auth method (Bearer, custom header, query param, Basic)

2. **Find a real SVG logo** from the internet (simpleicons.org, svgrepo.com, worldvectorlogo.com, brandfetch.com, or the service's official website/GitHub repo). **Never fabricate a logo.**

### Step B3: Create Feature Branch

```bash
git checkout -b feat/add-<name>-connector
```

### Step B4: Implement the Connector

Edit these files (use existing connectors like `twenty`, `qiita`, `zeptomail` as templates):

#### 4a. `turbo/packages/core/src/contracts/connectors.ts` (2 spots)

1. **CONNECTOR_TYPES_DEF** — Add connector config with label, helpText, authMethods (api-token), defaultAuthMethod. Insert alphabetically.

2. **connectorTypeSchema z.enum** — Add the connector type string

#### 4a2. `turbo/packages/core/src/contracts/services.ts` (1 spot)

- **SERVICE_CONFIGS** — Add service configuration if the API uses header-based auth:
  - Bearer auth: `api("https://api.example.com", bearerAuth("XXX_TOKEN"))`
  - Custom header: `api("https://api.example.com", { headers: { "x-api-key": "${{ secrets.XXX_TOKEN }}" } })`
  - **Skip** if auth is query-param-based or requires base64 encoding (Basic auth)

#### 4b. `turbo/apps/web/src/lib/connector/providers/<name>-handler.ts` (new file)

```typescript
import { type ProviderHandler } from "../provider-types";

export const <name>Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("<Name> does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("<Name> does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "XXX_TOKEN",
};
```

#### 4c. `turbo/apps/web/src/lib/connector/provider-registry.ts` (2 spots)

1. Add import for the handler
2. Add entry to `PROVIDER_HANDLERS` record

#### 4d. `turbo/apps/platform/src/views/settings-page/icons/<name>.svg` (new file)

The real SVG logo found in Step B2.

#### 4e. `turbo/apps/platform/src/views/settings-page/connector-icons.tsx` (2 spots)

1. Add import for the SVG icon
2. Add entry to `CONNECTOR_ICONS` record

### Step B5: Update vm0-skills Secret Name (if needed)

If the skill's `vm0_secrets` doesn't follow `XXX_TOKEN` convention, rename it:

```bash
SHA=$(gh api "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" --jq '.sha')
gh api "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" --jq '.content' | base64 -d | \
  sed 's/OLD_SECRET/NEW_SECRET/g' > /tmp/skill.md
CONTENT=$(base64 -w0 /tmp/skill.md)
gh api --method PUT "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" \
  -f message="chore: rename OLD_SECRET to NEW_SECRET" -f content="$CONTENT" -f sha="$SHA"
```

### Step B6: Commit and Push

```bash
git add <all changed files>
git commit -m "feat: add <name> api-token connector"
git push -u origin feat/add-<name>-connector
```

**Important:** Do NOT run `check-types` locally — it gets stuck. The lefthook pre-commit hook runs prettier + knip which is sufficient.

### Step B7: Create PR

```bash
gh pr create --title "feat: add <name> api-token connector" --body "$(cat <<'EOF'
## Summary
- Add <Name> as an api-token connector
- <Service config description or "No service config (query param auth)">
- <Secret rename description if applicable>

Closes #<issue-number>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Step B8: Return to Main

```bash
rm -f .claude/scheduled_tasks.lock
git checkout main
git stash 2>/dev/null; git pull; git stash pop 2>/dev/null; true
```

---

## Key Rules

- **One open connector PR at a time** — do not create a new connector PR while another is still open. Merge existing PRs first in Phase A
- **One PR per issue, one issue at a time**
- **Sequential PR processing** — never process multiple PRs in parallel
- **Never merge a PR you pushed to in the same round** — always wait for fresh CI
- **Disable auto-merge before pushing conflict fixes** — prevents stale auto-merge
- **15+ SUCCESS checks required before merging** — in_progress is not sufficient
- **Secret naming:** Always `XXX_TOKEN` — never `_API_KEY`, `_SECRET_KEY`, `_ACCESS_TOKEN`
- **Logo:** Must be from a real internet source — never self-created
- **Service config:** Only for header-based auth (Bearer, custom headers) in `services.ts`. Skip for query param auth or Basic auth requiring base64
- **No `check-types` locally** — it gets stuck. Rely on CI
- **Always pull after returning to main**
- **Conflict resolution for shared files:** These connectors only add new entries to shared files. Conflicts are always additive — keep ALL entries from both sides, maintain alphabetical order
