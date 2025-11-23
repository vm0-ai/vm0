---
description: Create a bug report with reproduction steps, environment details, and error information
---

# Create Bug Report Issue

Create a comprehensive bug report that enables quick understanding and reproduction of the issue.

## Core Principles

**Provide concrete, reproducible information:**
- How to reproduce the bug (specific steps)
- What's broken vs what's expected
- Environment details (browser, OS, version)
- Error messages and logs when available
- Impact on users

## Workflow

### 1. Gather Bug Information

If user provides initial description, extract:
- What went wrong (observed behavior)
- What should happen (expected behavior)
- How to reproduce it
- When/where it occurs
- Who is affected

### 2. Clarify Missing Details

Use AskUserQuestion to gather critical information:
- Unclear reproduction steps
- Missing environment details
- No error messages or logs
- Vague symptoms or impact
- Unknown frequency or conditions

Keep questions focused (3-5 max per round) and specific.

### 3. Create Issue

Organize information to enable quick reproduction and diagnosis:

**Essential elements:**
- Clear description of the problem
- Step-by-step reproduction
- Expected vs actual behavior
- Environment information
- Error messages/logs (when available)
- Impact assessment

**Principles for content:**
- Be specific and concrete
- Use exact error messages (not paraphrased)
- Provide complete reproduction steps
- Include relevant context
- Note frequency and conditions
- Assess severity honestly

**Helpful additions when available:**
- Screenshots or videos
- Console logs or stack traces
- Network request details
- Workarounds discovered

Create the issue directly with:
```bash
gh issue create \
  --title "bug: [concise description]" \
  --body "[Organized content]" \
  --label "bug"
```

**Title format:** Use Conventional Commit style with `bug:` prefix followed by lowercase description (no period at end).

### 4. Return Result

Show issue URL and ID. Keep response simple.

## Flexibility

Adapt content based on the bug:
- Some bugs need detailed environment info, others don't
- Some have clear errors, others have subtle symptoms
- Some are always reproducible, others are intermittent
- Focus on providing what's needed to fix this specific bug

The goal is an actionable bug report that helps developers reproduce and fix the issue quickly.
