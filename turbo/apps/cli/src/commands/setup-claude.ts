import { Command } from "commander";
import chalk from "chalk";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const SKILL_DIR = ".claude/skills/vm0-agent-builder";

// Embedded skill content - no external dependency on GitHub
const SKILL_CONTENT = `---
name: vm0-agent-builder
description: Guide for building VM0 agents with Claude's help. Use this skill when users want to create or improve their agent's AGENTS.md and vm0.yaml configuration.
---

# VM0 Agent Builder

Help users create effective AI agents using the VM0 platform. This skill guides the process of designing agent workflows, writing AGENTS.md instructions, and configuring vm0.yaml.

## When to Use

- User wants to create a new VM0 agent from scratch
- User wants to improve an existing agent's instructions
- User needs help configuring vm0.yaml with skills
- User is unsure how to structure their agent's workflow

## Workflow

### Step 1: Understand the Goal

Ask the user what they want their agent to accomplish:
- What is the main task or problem to solve?
- What inputs will the agent receive?
- What outputs should the agent produce?
- Are there any constraints or requirements?

### Step 2: Design the Workflow

Break down the task into clear, sequential steps:
1. Each step should be a single, focused action
2. Steps should build on each other logically
3. Include error handling and edge cases
4. Consider what tools/skills the agent will need

### Step 3: Write AGENTS.md

Create the agent instructions file with:

\`\`\`markdown
# Agent Instructions

You are a [role description].

## Goal

[Clear statement of what the agent should accomplish]

## Workflow

1. [First step with specific instructions]
2. [Second step with specific instructions]
3. [Continue with remaining steps...]

## Output

[Describe the expected output format and location]

## Constraints

[Any limitations or rules the agent should follow]
\`\`\`

### Step 4: Configure vm0.yaml

Update the vm0.yaml to include necessary skills:

\`\`\`yaml
version: "1.0"

agents:
  agent-name:
    framework: claude-code
    instructions: AGENTS.md
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/skill-name
    environment:
      # Add any required environment variables
      API_KEY: "\${{ secrets.API_KEY }}"
\`\`\`

### Step 5: Test the Agent

Guide the user to test their agent:

\`\`\`bash
# Deploy the agent configuration
vm0 compose vm0.yaml

# Run the agent with a test prompt
vm0 cook "start working on the task"

# Check the logs if needed
vm0 logs <run-id>
\`\`\`

## Available Skills

Common skills from vm0-skills repository:

| Skill | Purpose |
|-------|---------|
| \`github\` | GitHub API operations (issues, PRs, repos) |
| \`slack\` | Send messages to Slack channels |
| \`notion\` | Read/write Notion pages and databases |
| \`firecrawl\` | Web scraping and content extraction |
| \`browserbase\` | Browser automation |
| \`openai\` | OpenAI API for embeddings, completions |
| \`supabase\` | Database operations with Supabase |

Browse all skills: https://github.com/vm0-ai/vm0-skills

## Example Agents

### Content Curator Agent

\`\`\`markdown
# Agent Instructions

You are a content curator that monitors HackerNews for AI-related articles.

## Workflow

1. Go to HackerNews and read the top 30 stories
2. Filter for AI, ML, and LLM related content
3. For each relevant article, extract:
   - Title and URL
   - Key points (2-3 sentences)
   - Why it's interesting
4. Write a summary to \`daily-digest.md\`

## Output

Create \`daily-digest.md\` with today's date as the header.
\`\`\`

### GitHub Issue Tracker Agent

\`\`\`markdown
# Agent Instructions

You are a GitHub issue tracker that summarizes open issues.

## Workflow

1. List all open issues in the repository
2. Group issues by labels (bug, feature, docs)
3. For each group, summarize:
   - Number of issues
   - Oldest issue age
   - Most discussed issues
4. Create a report in \`issue-report.md\`

## Skills Required

- github (for API access)
\`\`\`

### Data Pipeline Agent

\`\`\`markdown
# Agent Instructions

You are a data pipeline agent that processes CSV files.

## Workflow

1. Read all CSV files from the input volume
2. For each file:
   - Validate the schema
   - Clean missing values
   - Transform dates to ISO format
3. Merge all files into \`combined.csv\`
4. Generate a summary report

## Input

Files are provided via volume mount.

## Output

Write results to the artifact directory.
\`\`\`

## Best Practices

1. **Be Specific**: Vague instructions lead to unpredictable results
2. **One Task Per Step**: Keep workflow steps focused and atomic
3. **Define Output Clearly**: Specify exact file names and formats
4. **Handle Errors**: Include what to do when things go wrong
5. **Test Incrementally**: Start with simple workflows, add complexity
6. **Use Skills Wisely**: Only include skills the agent actually needs

## Troubleshooting

### Agent doesn't follow instructions
- Make instructions more specific and explicit
- Add examples of expected behavior
- Break complex steps into smaller sub-steps

### Agent uses wrong tools
- Specify which tools/skills to use for each step
- Add constraints about what NOT to do

### Output format is wrong
- Provide exact templates for output files
- Include example output in the instructions
`;

export const setupClaudeCommand = new Command()
  .name("setup-claude")
  .description("Add/update Claude skill for agent building")
  .option(
    "--agent-dir <dir>",
    "Agent directory (shown in next step instructions)",
  )
  .action(async (options: { agentDir?: string }) => {
    console.log(chalk.dim("Installing vm0-agent-builder skill..."));

    // Create directory
    await mkdir(SKILL_DIR, { recursive: true });

    // Write skill file
    await writeFile(path.join(SKILL_DIR, "SKILL.md"), SKILL_CONTENT);

    console.log(
      chalk.green(`Done Installed vm0-agent-builder skill to ${SKILL_DIR}`),
    );
    console.log();
    console.log("Next step:");
    const cdPrefix = options.agentDir ? `cd ${options.agentDir} && ` : "";
    console.log(
      chalk.cyan(
        `  ${cdPrefix}claude "/vm0-agent-builder I want to build an agent that..."`,
      ),
    );
  });
