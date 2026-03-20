---
name: agent-api-connector
description: Implement an api-token connector from a GitHub issue — research, code, and create PR
context: fork
---

# Implement API-Token Connector

You are an api-token connector implementation specialist. Given an issue, you research the connector, implement it across the required files, and create a PR.

For PR lifecycle management (merge conflicts, CI monitoring, merging), use `/coding-loop api-token connector` instead.

## Arguments

Your args are: `$ARGUMENTS`

Parse the args to get the issue number. If no issue number is provided, find the next available issue automatically (see Step 1).

---

## Step 1: Find the Issue

If an issue number was provided, use it directly. Otherwise, find the next unlinked issue:

```bash
gh issue list --repo vm0-ai/vm0 --label "api-token connector" --state open \
  --json number,title,closedByPullRequestsReferences --limit 50
```

Filter to issues where `closedByPullRequestsReferences` is empty. Pick the lowest issue number.

Verify no existing open PR exists for this connector:

```bash
gh api "repos/vm0-ai/vm0/pulls?state=open&per_page=100" --jq '.[].title' | grep -i <connector-name>
```

If no unlinked issues remain, end.

## Step 2: Research the Connector

In parallel:

1. **Read the skill definition** from `vm0-ai/vm0-skills`:
   ```bash
   gh api "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" --jq '.content' | base64 -d
   ```
   - Note the `vm0_secrets` name — it must follow `XXX_TOKEN` convention per `docs/add-oauth-connector.md`
   - Note the API base URL and auth method (Bearer, custom header, query param, Basic)

2. **Find a real SVG logo** from the internet (simpleicons.org, svgrepo.com, worldvectorlogo.com, brandfetch.com, or the service's official website/GitHub repo). **Never fabricate a logo.**

## Step 3: Create Feature Branch

```bash
git checkout main && git pull
git checkout -b feat/add-<name>-connector
```

## Step 4: Implement the Connector

Edit these files (use existing connectors like `twenty`, `qiita`, `zeptomail` as templates):

### 4a. `turbo/packages/core/src/contracts/connectors.ts` (2 spots)

1. **CONNECTOR_TYPES_DEF** — Add connector config with label, helpText, authMethods (api-token), defaultAuthMethod. Insert alphabetically.

2. **connectorTypeSchema z.enum** — Add the connector type string

### 4b. `turbo/packages/core/src/contracts/services.ts` (1 spot)

- **SERVICE_CONFIGS** — Add service configuration if the API uses header-based auth:
  - Bearer auth: `api("https://api.example.com", bearerAuth("XXX_TOKEN"))`
  - Custom header: `api("https://api.example.com", { headers: { "x-api-key": "${{ secrets.XXX_TOKEN }}" } })`
  - **Skip** if auth is query-param-based or requires base64 encoding (Basic auth)

### 4c. `turbo/apps/web/src/lib/connector/providers/<name>-handler.ts` (new file)

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

### 4d. `turbo/apps/web/src/lib/connector/provider-registry.ts` (2 spots)

1. Add import for the handler
2. Add entry to `PROVIDER_HANDLERS` record

### 4e. `turbo/apps/platform/src/views/settings-page/icons/<name>.svg` (new file)

The real SVG logo found in Step 2.

### 4f. `turbo/apps/platform/src/views/settings-page/connector-icons.tsx` (2 spots)

1. Add import for the SVG icon
2. Add entry to `CONNECTOR_ICONS` record

## Step 5: Update vm0-skills Secret Name (if needed)

If the skill's `vm0_secrets` doesn't follow `XXX_TOKEN` convention, rename it:

```bash
SHA=$(gh api "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" --jq '.sha')
gh api "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" --jq '.content' | base64 -d | \
  sed 's/OLD_SECRET/NEW_SECRET/g' > /tmp/skill.md
CONTENT=$(base64 -w0 /tmp/skill.md)
gh api --method PUT "repos/vm0-ai/vm0-skills/contents/<name>/SKILL.md" \
  -f message="chore: rename OLD_SECRET to NEW_SECRET" -f content="$CONTENT" -f sha="$SHA"
```

## Step 6: Commit and Push

```bash
git add <all changed files>
git commit -m "feat: add <name> api-token connector"
git push -u origin feat/add-<name>-connector
```

**Important:** Do NOT run `check-types` locally — it gets stuck. The lefthook pre-commit hook runs prettier + knip which is sufficient.

## Step 7: Create PR

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

---

## Key Rules

- **Secret naming:** Always `XXX_TOKEN` — never `_API_KEY`, `_SECRET_KEY`, `_ACCESS_TOKEN`
- **Logo:** Must be from a real internet source — never self-created
- **Service config:** Only for header-based auth (Bearer, custom headers) in `services.ts`. Skip for query param auth or Basic auth requiring base64
- **No `check-types` locally** — it gets stuck. Rely on CI
- **Alphabetical ordering** — Insert new entries alphabetically in all shared files (connectors.ts, services.ts, provider-registry.ts, connector-icons.tsx)
