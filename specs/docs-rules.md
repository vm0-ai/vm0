# Integration Documentation Rules

This document defines the structure and standards for documenting SaaS integrations in `turbo/apps/docs/content/docs/integration/`.

## File Location

All integration documentation files should be located at:
```
turbo/apps/docs/content/docs/integration/{skill-name}.mdx
```

## Key Principles

1. **Consistency with vm0-skills**: Each integration doc should align with the corresponding skill description in the `vm0-ai/vm0-skills` repository
2. **Standard Structure**: Follow the structure defined in the "Integration Document Structure" section below

## Adding to Navigation

Add new integration files to `turbo/apps/docs/content/docs/integration/meta.json` in **alphabetical order**:

```json
{
  "title": "Integration",
  "pages": [
    "existing-skill",
    "{new-skill-name}"
  ]
}
```

---

# Integration Document Structure

## Front Matter and Introduction

Every integration doc must start with:
- **Title**: The official SaaS service name
- **Description**: Brief one-line explanation of the primary problem the SaaS solves
- **First paragraph**: Links to the official website and provides a concise overview

**Example:**

```mdx
---
title: {SaaS Name}
description: {Brief description of what the SaaS does}
---

[{SaaS Name}]({official-website-url}) is {one sentence description of the SaaS}.
```

## Required Environment Section

This section documents all environment variables needed for the integration.

**Guidelines:**
- **Critical**: The environment variable types must strictly match the corresponding `vm0-ai/vm0-skills/<SAAS_NAME>/SKILL.md` file
  - Variables listed under `vm0_secrets` in SKILL.md must be marked as `secret` in the documentation
  - Variables listed under `vm0_vars` in SKILL.md must be marked as `var` in the documentation
  - When checking compliance, always read the corresponding SKILL.md file to verify correctness
- Create a table listing all `vm0_secrets` and `vm0_vars` from the corresponding SKILL.md file
- Table must have three columns:
  - **Name**: The environment variable name
  - **Type**: Either `secret` or `var` (must match SKILL.md)
  - **Description**: Explains the variable's purpose. Include links to where users can obtain tokens/keys (e.g., [XXX Dashboard](https://...))

**Example:**

| Name                  | Type   | Description                                           |
| --------------------- | ------ | ----------------------------------------------------- |
| `CHATWOOT_API_TOKEN`  | secret | API access token from [Chatwoot Profile Settings](https://...)       |
| `CHATWOOT_ACCOUNT_ID` | var    | Account ID from the URL (e.g., `/app/accounts/1/...`) |
| `CHATWOOT_BASE_URL`   | var    | Base URL (e.g., `https://app.chatwoot.com`)           |

## Configuration Section

This section shows how to configure the skill in `vm0.yaml`.

**Guidelines:**
- Provide a minimal `vm0.yaml` example
- Highlight the skill reference line using `# [!code highlight]`
- Only include the skill URL in the skills array (no environment block needed)

**Example:**

```yaml title="vm0.yaml"
version: "1.0"

agents:
  my-agent:
    framework: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/apify # [!code highlight]
```

## Run Section

This section demonstrates how to pass environment variables when running the agent.

**Guidelines:**
- Use a backslash `\` to separate the `vm0 run` command and the parameters into two lines
- **Critical**: All `--secrets` and `--vars` parameters must be on the same line (the second line) - do not split them with additional backslashes
- Ensure the variables match those listed in the "Required Environment" section
- Highlight the second line (containing all secrets/vars) using `# [!code highlight]`

**Correct Format:**

```bash
vm0 run my-agent "list open conversations" \
  --secrets CHATWOOT_API_TOKEN=xxx --vars CHATWOOT_ACCOUNT_ID=xxx --vars CHATWOOT_BASE_URL=xxx # [!code highlight]
```

**Incorrect Format (DO NOT USE):**

```bash
# ❌ Wrong: Everything on one line without backslash
vm0 run my-agent "list open conversations" --secrets CHATWOOT_API_TOKEN=xxx --vars CHATWOOT_ACCOUNT_ID=xxx --vars CHATWOOT_BASE_URL=xxx # [!code highlight]

# ❌ Wrong: Splitting secrets/vars across multiple lines
vm0 run my-agent "list open conversations" \
  --secrets CHATWOOT_API_TOKEN=xxx \
  --vars CHATWOOT_ACCOUNT_ID=xxx --vars CHATWOOT_BASE_URL=xxx # [!code highlight]
```

## Example Instructions Section

This section provides two example `AGENTS.md` configurations demonstrating different use cases.

**Guidelines:**
- Include exactly two examples showing different workflows
- Each example should mention using the SaaS service to implement a specific workflow
- Structure each example with:
  - Agent title describing its purpose
  - Introduction mentioning the SaaS usage
  - Workflow section with numbered steps
  - Additional relevant sections (Guidelines, Capabilities, Rules, etc.)

**Example:**

```markdown title="AGENTS.md"
# Support Agent

You use Chatwoot to manage customer support conversations.

## Workflow

1. List open conversations
2. Read conversation messages
3. Send appropriate replies
4. Update conversation status

## Guidelines

- Use private notes for internal communication
- Assign conversations to appropriate agents
```

```markdown title="AGENTS.md"
# Contact Manager Agent

You use Chatwoot to manage customer contacts.

## Workflow

1. Search for existing contacts
2. Create new contacts if needed
3. Update contact information
4. Link contacts to conversations

## Contact Fields

- name, email, phone_number
- identifier (external system ID)
- custom_attributes
```

---

## Code Highlighting Best Practices

- Use Shiki's `# [!code highlight]` syntax to emphasize important lines
- In YAML: Add `# [!code highlight]` at the end of the line
- In Bash: Highlighting only works on lines without `\` continuation
  - For commands with multiple secrets/vars, consolidate them on a single line before the highlight comment
  - Never split highlighted content across multiple lines with backslash continuations
