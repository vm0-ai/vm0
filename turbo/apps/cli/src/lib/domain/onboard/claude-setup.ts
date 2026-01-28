import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const SKILL_DIR = ".claude/skills/vm0-agent-builder";
export const SKILL_FILE = "SKILL.md";

/**
 * Get the vm0-agent-builder skill content
 */
export function getSkillContent(): string {
  return `---
name: vm0-agent-builder
description: Build VM0 agents by creating AGENTS.md and vm0.yaml. Use when users describe what agent they want to build.
---

# VM0 Agent Builder

Build AI agents that run in VM0's secure sandbox environment. This skill helps you create the two essential files: \`AGENTS.md\` (agent instructions) and \`vm0.yaml\` (configuration).

## Workflow

### Step 1: Understand the Goal

First, clarify what the user wants their agent to do:
- What task should the agent accomplish?
- What inputs does it need? (files, APIs, websites)
- What outputs should it produce? (reports, files, notifications)
- Should it run once or on a schedule?

### Step 2: Create AGENTS.md

Write clear, step-by-step instructions. The agent will follow these exactly.

**Template:**

\`\`\`markdown
# [Agent Name]

You are a [role description].

## Workflow

1. [First action - be specific]
2. [Second action - include details]
3. [Continue with clear steps...]

## Output

Write results to \`[filename]\` in the current directory.
\`\`\`

**Writing Tips:**
- Be specific: "Read the top 10 stories" not "Read some stories"
- One action per step: Keep steps focused and atomic
- Specify output: Exact filenames and formats
- Use active voice: "Create a file" not "A file should be created"

### Step 3: Create vm0.yaml

Configure the agent with required skills and environment variables.

\`\`\`yaml
version: "1.0"

agents:
  [agent-name]:
    framework: claude-code
    instructions: AGENTS.md
    # Pre-install GitHub CLI (optional)
    apps:
      - github
    # Add skills the agent needs (optional)
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/[skill-name]
    # Mount volumes for input files (optional)
    volumes:
      - my-volume:/home/user/input
    # Environment variables (optional)
    environment:
      API_KEY: "\${{ secrets.API_KEY }}"
\`\`\`

### Step 4: Test the Agent

After creating both files, the user runs:

\`\`\`bash
vm0 cook "start working"
\`\`\`

This command:
1. Uploads the configuration to VM0
2. Runs the agent in a secure sandbox
3. Downloads results to the \`artifact/\` directory

## Available Skills

Skills give agents access to external services. Add them to vm0.yaml when needed.

**Popular Skills:**

| Skill | Use Case |
|-------|----------|
| \`github\` | Read/write issues, PRs, files |
| \`slack\` | Send messages to channels |
| \`notion\` | Access Notion pages/databases |
| \`firecrawl\` | Scrape and extract web content |
| \`supabase\` | Database operations |
| \`google-sheets\` | Read/write spreadsheets |
| \`linear\` | Project management |
| \`discord\` | Send Discord messages |
| \`gmail\` | Send emails |
| \`openai\` | Embeddings, additional AI calls |

**All 79 skills:** https://github.com/vm0-ai/vm0-skills

**Skill URL format:**
\`\`\`
https://github.com/vm0-ai/vm0-skills/tree/main/[skill-name]
\`\`\`

## Examples

### HackerNews Curator

**AGENTS.md:**
\`\`\`markdown
# HackerNews AI Curator

You are a content curator that finds AI-related articles on HackerNews.

## Workflow

1. Go to https://news.ycombinator.com
2. Read the top 30 stories
3. Filter for AI, ML, and LLM related content
4. For each relevant article, extract:
   - Title and URL
   - 2-3 sentence summary
   - Why it matters
5. Write findings to \`daily-digest.md\`

## Output

Create \`daily-digest.md\` with today's date as the header.
Format as a bulleted list with links.
\`\`\`

**vm0.yaml:**
\`\`\`yaml
version: "1.0"

agents:
  hn-curator:
    framework: claude-code
    instructions: AGENTS.md
\`\`\`

### GitHub Issue Reporter

**AGENTS.md:**
\`\`\`markdown
# GitHub Issue Reporter

You are a GitHub analyst that creates issue summary reports.

## Workflow

1. List all open issues in the repository
2. Group by labels: bug, feature, documentation, other
3. For each group, report:
   - Total count
   - Oldest issue (with age in days)
   - Most commented issue
4. Write report to \`issue-report.md\`

## Output

Create \`issue-report.md\` with sections for each label group.
Include links to referenced issues.
\`\`\`

**vm0.yaml:**
\`\`\`yaml
version: "1.0"

agents:
  issue-reporter:
    framework: claude-code
    instructions: AGENTS.md
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
    environment:
      GITHUB_REPO: "\${{ vars.GITHUB_REPO }}"
\`\`\`

### Slack Daily Digest

**AGENTS.md:**
\`\`\`markdown
# Slack Daily Digest

You are an assistant that posts daily summaries to Slack.

## Workflow

1. Read the contents of \`updates.md\` from the input volume
2. Summarize the key points (max 5 bullets)
3. Format as a Slack message with emoji headers
4. Post to the #daily-updates channel

## Output

Post the summary to Slack. Write a copy to \`sent-message.md\`.
\`\`\`

**vm0.yaml:**
\`\`\`yaml
version: "1.0"

agents:
  slack-digest:
    framework: claude-code
    instructions: AGENTS.md
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/slack
    environment:
      SLACK_CHANNEL: "\${{ vars.SLACK_CHANNEL }}"
\`\`\`

## Environment Variables

Use environment variables for sensitive data and configuration:

\`\`\`yaml
environment:
  # Secrets (encrypted, for API keys)
  API_KEY: "\${{ secrets.API_KEY }}"

  # Variables (plain text, for config)
  REPO_NAME: "\${{ vars.REPO_NAME }}"

  # Credentials (from vm0 credential storage)
  MY_TOKEN: "\${{ credentials.MY_TOKEN }}"
\`\`\`

Set credentials with (names must be UPPERCASE):
\`\`\`bash
vm0 credential set API_KEY "your-api-key"
\`\`\`

## Troubleshooting

**Agent doesn't follow instructions:**
- Make steps more specific and explicit
- Add "Do not..." constraints for unwanted behavior
- Break complex steps into smaller sub-steps

**Agent can't access a service:**
- Add the required skill to vm0.yaml
- Set up credentials with \`vm0 credential set\`

**Output is in wrong format:**
- Provide an exact template in the instructions
- Include a small example of expected output

## Next Steps After Creating Files

\`\`\`bash
# Run your agent
vm0 cook "start working"

# View logs if needed
vm0 logs [run-id]

# Results are in artifact/ directory
ls artifact/

# Continue from where agent left off
vm0 cook continue "keep going"

# Resume from a checkpoint
vm0 cook resume "try again"
\`\`\`
`;
}

interface InstallSkillResult {
  skillDir: string;
  skillFile: string;
}

/**
 * Install the vm0-agent-builder skill in the specified directory
 * @param targetDir - Base directory to install the skill in (defaults to current directory)
 */
export async function installClaudeSkill(
  targetDir: string = process.cwd(),
): Promise<InstallSkillResult> {
  const skillDirPath = path.join(targetDir, SKILL_DIR);
  const skillFilePath = path.join(skillDirPath, SKILL_FILE);

  await mkdir(skillDirPath, { recursive: true });
  await writeFile(skillFilePath, getSkillContent());

  return {
    skillDir: skillDirPath,
    skillFile: skillFilePath,
  };
}
