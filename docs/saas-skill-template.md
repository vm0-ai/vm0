# SaaS Skill Documentation Template

This template defines the structure for documenting SaaS integrations in `turbo/apps/docs/content/docs/integration/`.

## File Location

```
turbo/apps/docs/content/docs/integration/{skill-name}.mdx
```

## Template Structure

```mdx
---
title: {SaaS Name}
description: {Brief description of what the SaaS does}
---

[{SaaS Name}]({official-website-url}) is {one sentence description of the SaaS}.

## Required Secrets

| Secret | Description |
| ------ | ----------- |
| `{SECRET_NAME}` | {Description with link to where to get it} |

## Configuration

```yaml title="vm0.yaml"
version: "1.0"

agents:
  my-agent:
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/{skill-name} # [!code highlight]
    environment:
      {SECRET_NAME}: "${{ secrets.{SECRET_NAME} }}" # [!code highlight]
```

## Run

```bash
vm0 run my-agent "{example prompt}" \
  --secrets {SECRET_NAME}=xxx # [!code highlight]
```

## Example Instructions

```markdown title="AGENTS.md"
# {Use Case 1} Agent

You {description of what this agent does}.

## Workflow

1. {Step 1}
2. {Step 2}
3. {Step 3}

## {Section title like Capabilities/Output/Rules}

- {Item 1}
- {Item 2}
- {Item 3}
```

```markdown title="AGENTS.md"
# {Use Case 2} Agent

You {description of what this agent does}.

## Workflow

1. {Step 1}
2. {Step 2}
3. {Step 3}

## {Section title}

- {Item 1}
- {Item 2}
- {Item 3}
```
```

## Code Highlighting

Use Shiki's `# [!code highlight]` syntax to highlight important lines:

- In YAML: Add `# [!code highlight]` at end of line
- In Bash: Only works on lines without `\` continuation
  - For multiple secrets, put them on one line

## Checklist

- [ ] Title matches SaaS name
- [ ] Description is concise
- [ ] Official website linked in intro
- [ ] All required secrets documented with source links
- [ ] Configuration shows skill URL and environment variables
- [ ] Run example shows how to pass secrets via CLI
- [ ] 2 example AGENTS.md instructions showing different use cases
- [ ] Code highlighting on skill URL and secrets lines

## Adding to Navigation

Add the new file to `turbo/apps/docs/content/docs/integration/meta.json`:

```json
{
  "title": "Integration",
  "pages": [
    "existing-skill",
    "{new-skill-name}"
  ]
}
```
