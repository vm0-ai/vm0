---
name: issue-handoff
description: Create a GitHub issue and hand it off to a coding agent worker via load balancing. Combines issue-create and coding-assign.
---

# Issue Handoff Skill

You are a GitHub issue creation and handoff specialist. Your role is to create well-structured GitHub issues from conversation context and hand them off to a coding agent worker using load balancing.

## Arguments

Your args are: `$ARGUMENTS`

Parse the args to determine:

1. **Operation type** (optional): `create` (default), `bug`, or `feature` — same as issue-create
2. **Label parameter** (`^`): If the args contain `^` followed by a label name (e.g., `^urgent`), apply that label to the created issue in addition to the default labels
3. **Worker count** (optional number): The number of coding workers for distribution. Defaults to **4** if not provided.

### Argument Examples

```
# No args — create issue, distribute across 4 workers
/issue-handoff

# Specify 8 workers
/issue-handoff 8

# Create with a specific label
/issue-handoff ^urgent

# Feature request with label and 6 workers
/issue-handoff feature ^backend 6

# Bug report with default workers
/issue-handoff bug

# Bug with label
/issue-handoff bug ^critical 8
```

**Parsing rules:**
- A bare number (e.g., `4`, `8`) is the worker count
- `^label-name` is the label parameter — the `^` character followed immediately by the label name
- `create`, `bug`, or `feature` is the operation type
- Arguments can appear in any order
- Defaults: operation = `create`, worker count = `4`, label = none

---

## Workflow

This skill runs in two phases: **Create** then **Assign**.

---

## Phase 1: Create Issue

Follow the exact same workflow as issue-create based on the operation type (`create`, `bug`, or `feature`).

### Operation: create

#### Step 1: Analyze Conversation Context

Review the current conversation to identify:
- What is the user trying to accomplish or solve?
- What problem or need has been discussed?
- What decisions or insights have emerged?
- What relevant code, files, or technical context exists?
- What questions or uncertainties remain?

#### Step 2: Determine Issue Nature

Based on conversation, identify what type of issue this is:
- Feature request or enhancement
- Bug report or defect
- Technical task or chore
- Investigation or spike
- Documentation need
- Or any other category that fits

#### Step 3: Clarify with User (Required)

Use AskUserQuestion to:
- Confirm your understanding of what should be captured
- Resolve any ambiguities or unclear points
- Verify scope and priority
- Fill gaps in information

Ask 2-4 focused questions.

#### Step 4: Create Issue

**Title format:** Conventional Commit style prefix (`feat:`, `bug:`, `refactor:`, etc.) followed by lowercase description, no period.

**Labeling:**
- Choose labels based on issue nature (`enhancement`, `bug`, `documentation`, `tech-debt`, etc.)
- If a `^label` parameter was provided, include that label as well
- Always include the `pending` label (it will be replaced by the worker label in Phase 2)

```bash
gh issue create \
  --title "[type]: [clear, descriptive description]" \
  --body "[Synthesized content]" \
  --label "[appropriate-labels],pending" \
  --assignee @me
```

If a `^label` was specified, add it to the label list:
```bash
gh issue create \
  --title "[type]: [clear, descriptive description]" \
  --body "[Synthesized content]" \
  --label "[appropriate-labels],pending,[specified-label]" \
  --assignee @me
```

### Operation: bug

Follow the same bug workflow as issue-create:
1. Gather bug information from conversation
2. Clarify missing details via AskUserQuestion
3. Create with `bug:` title prefix, `bug` label, plus `pending` label (and `^label` if specified)

### Operation: feature

Follow the same feature workflow as issue-create:
1. Gather feature information from conversation
2. Clarify ambiguities via AskUserQuestion
3. Create with `feat:` title prefix, `enhancement` label, plus `pending` label (and `^label` if specified)

---

## Phase 2: Assign to Coding Worker

After the issue is created, immediately assign it to a coding worker using load balancing.

### Step 1: Capture Issue Number

Extract the issue number from the `gh issue create` output.

### Step 2: Get Current User

```bash
ME=$(gh api user --jq '.login')
```

### Step 3: Count Issues and PRs Per Worker

Using the worker count (default 4, or as specified in args), count **both** open issues and open PRs for each worker:

```bash
MAX_WORKERS=<from args or 4>
for i in $(seq 1 $MAX_WORKERS); do
  LABEL=$(printf "vm%02d" "$i")
  ISSUE_COUNT=$(gh issue list --repo vm0-ai/vm0 --label "$LABEL" --assignee "$ME" --state open --json number --jq 'length')
  PR_COUNT=$(gh pr list --repo vm0-ai/vm0 --label "$LABEL" --author "$ME" --state open --json number --jq 'length')
  TOTAL=$((ISSUE_COUNT + PR_COUNT))
  echo "$LABEL: $TOTAL (issues: $ISSUE_COUNT, PRs: $PR_COUNT)"
done
```

**Label format**: Always use `printf "vm%02d"` to generate labels — this produces `vm01`..`vm09` for single digits and `vm10`..`vm99` for double digits. Never use `seq -w` combined with string concatenation.

### Step 4: Select Least-Loaded Worker

Pick the worker label with the lowest total (issues + PRs). Prefer workers with **zero** total items. If there's a tie, pick the lowest-numbered worker.

### Step 5: Update Issue Labels

1. **Remove `pending` label**:
   ```bash
   gh issue edit $ISSUE --remove-label "pending"
   ```

2. **Ensure the worker label exists**:
   ```bash
   gh label create "$SELECTED_LABEL" --description "Coding worker $SELECTED_LABEL" --color 0E8A16 2>/dev/null || true
   ```

3. **Add the selected worker label**:
   ```bash
   gh issue edit $ISSUE --add-label "$SELECTED_LABEL"
   ```

### Step 6: Report

Output a combined summary:

```
Issue created and assigned: https://github.com/owner/repo/issues/123
Assigned to worker: <LABEL>

Worker load (issues + PRs):
  vm01: 3 (issues: 2, PRs: 1)
  vm02: 0 (issues: 0, PRs: 0)  <-- assigned here
  vm03: 3 (issues: 1, PRs: 2)
  vm04: 4 (issues: 3, PRs: 1)
```

---

## Key Rules

- **Always create then assign** — the two phases are sequential
- **Always pick the least-loaded worker** — balance is the primary goal
- **Break ties by lowest number** — prefer `vm01` over `vm02` when equal
- **Remove `pending` label** — replaced by the worker label
- **Create labels on demand** — if `vm0N` label doesn't exist, create it
- **One worker label per issue** — do not add multiple worker labels
- **`^label` is additive** — it does not replace default labels, it adds to them
- **Ensure the `^label` exists** — create it if needed before applying
- **Display the issue URL** — always show the URL to the user at the end
