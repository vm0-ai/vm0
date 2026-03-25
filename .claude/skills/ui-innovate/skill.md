---
name: ui-innovate
description: Generate UI design variants for a GitHub issue. Snapshots baseline pages, creates 3 solution variants, publishes to GitHub Pages, and comments on the issue.
---

# UI Innovate Skill

You are a UI design exploration specialist. Your role is to take a GitHub issue describing a UI change, reproduce the current state in a browser, snapshot the relevant pages as baselines, then generate 3 distinct design solution variants by modifying the baseline HTML.

## Arguments

Your args are: `$ARGUMENTS`

Parse the args to get the GitHub issue number. For example, if args is `5930`, work on issue #5930.

If no issue number is provided, ask the user: "Which issue would you like to explore UI designs for? Please provide the issue number."

## Workflow

### Step 1: Fetch Issue Details

```bash
gh issue view <issue-number> --repo vm0-ai/vm0
```

Read the issue title, description, and acceptance criteria carefully. Identify:
- Which pages/screens need to be changed
- What UI elements need to be added, modified, or removed
- The user-facing behavior being requested

### Step 2: Start Dev Server & Authenticate Browser

Use the `/dev-start` skill to start the dev server if not already running.

Then authenticate the browser using the e2e auth automation script:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
GIT_EMAIL_PREFIX=$(git config user.email | sed 's/@.*//')
HOSTNAME=$(hostname)
TEST_EMAIL="${GIT_EMAIL_PREFIX}-${HOSTNAME}+clerk_test@vm0.ai"

cd "$PROJECT_ROOT" && E2E_ACCOUNT="$TEST_EMAIL" VM0_API_URL="https://www.vm7.ai:8443" \
  ./e2e/test/libs/bats/bin/bats ./e2e/tests/02-browser/brw-t01-auth.bats
```

If the browser is already authenticated (check by navigating to `https://app.vm7.ai:8443` and verifying no redirect to sign-in), skip this step.

### Step 3: Reproduce Scenarios & Capture Baselines

Navigate to the relevant pages described in the issue using agent-browser. For each scenario:

1. Navigate to the page
2. Set up the page state (e.g., create test data, open modals, etc.)
3. Inject the freeze-dry bundle and capture a snapshot

**Injecting freeze-dry:**

```bash
# Download and inject the bundle (only needed once per browser session)
curl -sL https://raw.githubusercontent.com/vm0-ai/freeze-dry-bundle/main/freeze-dry-bundle.js | agent-browser eval --stdin
```

**Capturing a snapshot:**

```bash
agent-browser eval --stdin <<'EVALEOF'
(async () => {
  const html = await window.freezeDry(document);
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'FILENAME.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
})();
EVALEOF
```

Replace `FILENAME` with a descriptive name like `schedule-list-view.html` or `schedule-detail-empty.html`.

The file will be saved to `~/Downloads/FILENAME.html`.

Capture all relevant scenarios. Typically this includes:
- The main page in its current state
- Different states (empty, populated, loading, error) if relevant to the issue
- Related pages that provide context

### Step 4: Clone ui-innovate Repo & Set Up Issue Directory

```bash
cd /tmp && rm -rf ui-innovate-repo
git clone https://github.com/vm0-ai/ui-innovate.git /tmp/ui-innovate-repo
cd /tmp/ui-innovate-repo
mkdir -p issues/<issue-number>/baseline
mkdir -p issues/<issue-number>/variant-a
mkdir -p issues/<issue-number>/variant-b
mkdir -p issues/<issue-number>/variant-c
```

Copy the baseline snapshots:

```bash
cp ~/Downloads/<snapshot-files>.html /tmp/ui-innovate-repo/issues/<issue-number>/baseline/
```

### Step 5: Generate 3 Design Variants

Read each baseline HTML file. Then create 3 distinct design variants by modifying the HTML/CSS directly. Each variant should take a different approach to solving the issue.

**Guidelines for creating variants:**

- **Variant A**: The most conservative/minimal approach — smallest change that addresses the issue
- **Variant B**: A balanced approach — good UX with moderate changes
- **Variant C**: The most ambitious/innovative approach — best possible UX, may involve larger changes

**For each variant:**

1. Read the baseline HTML file
2. Modify the DOM and inline CSS to implement the design change
3. Keep all existing styles intact — only add or modify what's needed
4. Write the modified HTML to the variant directory

Use the Edit tool or Write tool to modify the HTML files. The baseline files are self-contained (all CSS inlined, images as data URIs), so you can freely edit them.

**Important**: Make the changes look realistic and polished. Use the existing design system colors, spacing, and typography from the baseline HTML. Do not introduce jarring visual differences — the variants should look like natural extensions of the current UI.

### Step 6: Create Index Page

Create an `issues/<issue-number>/index.html` that provides navigation between the baseline and all variants:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Issue #<issue-number> — UI Design Variants</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .header { background: #fff; border-bottom: 1px solid #e0e0e0; padding: 24px 32px; }
    .header h1 { font-size: 20px; font-weight: 600; }
    .header p { color: #666; margin-top: 8px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(600px, 1fr)); gap: 24px; padding: 24px 32px; }
    .card { background: #fff; border-radius: 8px; border: 1px solid #e0e0e0; overflow: hidden; }
    .card-header { padding: 16px 20px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; }
    .card-header h2 { font-size: 16px; font-weight: 600; }
    .badge { font-size: 12px; padding: 2px 8px; border-radius: 12px; font-weight: 500; }
    .badge-baseline { background: #e8e8e8; color: #666; }
    .badge-a { background: #dbeafe; color: #1d4ed8; }
    .badge-b { background: #dcfce7; color: #16a34a; }
    .badge-c { background: #fef3c7; color: #d97706; }
    .card-desc { padding: 12px 20px; font-size: 13px; color: #666; border-bottom: 1px solid #f0f0f0; }
    iframe { width: 100%; height: 600px; border: none; }
    .links { padding: 12px 20px; border-top: 1px solid #e0e0e0; }
    .links a { font-size: 13px; color: #2563eb; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Issue #ISSUE_NUMBER — ISSUE_TITLE</h1>
    <p>ISSUE_SUMMARY</p>
  </div>
  <div class="grid">
    <!-- Baseline card(s) -->
    <!-- Variant A/B/C cards -->
  </div>
</body>
</html>
```

For each baseline and variant, add a card with:
- An `<iframe>` pointing to the HTML file (relative path like `baseline/page.html`)
- A description of what the variant changes
- A direct link to open the HTML file standalone

### Step 7: Commit & Push to ui-innovate

```bash
cd /tmp/ui-innovate-repo
git add issues/<issue-number>/
git commit -m "feat: add UI design variants for issue #<issue-number>

Baseline snapshots and 3 design variants for: <issue-title>

- Variant A: <brief description>
- Variant B: <brief description>
- Variant C: <brief description>

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"

git push origin main
```

### Step 8: Comment on the Issue

Wait a moment for GitHub Pages to deploy, then comment on the issue with links to the variants.

The GitHub Pages base URL is: `https://vm0-ai.github.io/ui-innovate/`

```bash
gh issue comment <issue-number> --repo vm0-ai/vm0 --body "$(cat <<'EOF'
## UI Design Exploration

I've created 3 design variants for this issue. You can preview them here:

**[View all variants →](https://vm0-ai.github.io/ui-innovate/issues/<issue-number>/)**

### Variant A — <Title>
<One-line description of the approach>
[Preview](https://vm0-ai.github.io/ui-innovate/issues/<issue-number>/variant-a/<file>.html)

### Variant B — <Title>
<One-line description of the approach>
[Preview](https://vm0-ai.github.io/ui-innovate/issues/<issue-number>/variant-b/<file>.html)

### Variant C — <Title>
<One-line description of the approach>
[Preview](https://vm0-ai.github.io/ui-innovate/issues/<issue-number>/variant-c/<file>.html)

---
<sub>Baselines and variants generated with [freeze-dry](https://github.com/vm0-ai/freeze-dry-bundle) · [Source](https://github.com/vm0-ai/ui-innovate/tree/main/issues/<issue-number>)</sub>
EOF
)"
```

### Step 9: Report to User

Display a summary:

```
✅ UI design variants published for issue #<issue-number>

📄 Index: https://vm0-ai.github.io/ui-innovate/issues/<issue-number>/
💬 Comment posted on issue #<issue-number>

Variants:
  A — <title>: <description>
  B — <title>: <description>
  C — <title>: <description>

Waiting for human review. The chosen variant will inform the implementation.
```

## URL Rules

**CRITICAL: Always use the local vm7.ai domains with HTTPS port 8443.**

| Service | URL                        |
| ------- | -------------------------- |
| Web     | `https://www.vm7.ai:8443`  |
| App     | `https://app.vm7.ai:8443`  |
| Docs    | `https://docs.vm7.ai:8443` |

## Tips for Editing Snapshot HTML

- The baseline HTML files are self-contained with all CSS inlined. Search for existing class names and style blocks to understand the design tokens in use.
- Use `data-emotion` style blocks for Emotion/CSS-in-JS styles — these contain the actual rendered CSS.
- When adding new elements, copy the style patterns from adjacent elements in the HTML to maintain visual consistency.
- Keep the `<meta http-equiv="Content-Security-Policy">` tag that freeze-dry adds — it restricts resource loading to `data:` URIs and inline styles, which is exactly what we want for self-contained snapshots.
- Test your modifications by opening them in agent-browser: `agent-browser open "file:///path/to/variant.html"` and taking a screenshot to verify.
