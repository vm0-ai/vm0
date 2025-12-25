import { Command } from "commander";
import chalk from "chalk";
import * as readline from "readline";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { validateAgentName } from "../lib/yaml-validator";

const VM0_YAML_FILE = "vm0.yaml";
const AGENTS_MD_FILE = "AGENTS.md";

function generateVm0Yaml(agentName: string): string {
  return `version: "1.0"

agents:
  ${agentName}:
    provider: claude-code
    # Build agentic workflow using natural language
    instructions: AGENTS.md
    # Agent skills - see https://github.com/vm0-ai/vm0-skills for available skills
    # skills:
    #   - https://github.com/vm0-ai/vm0-skills/tree/main/github
    environment:
      # Get token using: claude setup-token, then add to .env file
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
`;
}

function generateAgentsMd(): string {
  return `# Agent Instructions

You are a HackerNews AI content curator.

## Workflow

1. Go to HackerNews and read the top 10 articles
2. Find and extract AI-related content from these articles
3. Summarize the findings into a X (Twitter) post format
4. Write the summary to content.md
`;
}

function checkExistingFiles(): string[] {
  const existingFiles: string[] = [];
  if (existsSync(VM0_YAML_FILE)) existingFiles.push(VM0_YAML_FILE);
  if (existsSync(AGENTS_MD_FILE)) existingFiles.push(AGENTS_MD_FILE);
  return existingFiles;
}

async function promptAgentName(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    rl.question(chalk.cyan("? Enter agent name: "), (answer) => {
      rl.close();
      resolve(answer.trim());
    });

    rl.on("SIGINT", () => {
      rl.close();
      console.log();
      reject(new Error("User cancelled"));
    });
  });
}

export const initCommand = new Command()
  .name("init")
  .description("Initialize a new VM0 project in the current directory")
  .option("-f, --force", "Overwrite existing files")
  .option("-n, --name <name>", "Agent name (skips interactive prompt)")
  .action(async (options: { force?: boolean; name?: string }) => {
    // Check existing files
    const existingFiles = checkExistingFiles();
    if (existingFiles.length > 0 && !options.force) {
      for (const file of existingFiles) {
        console.log(chalk.red(`✗ ${file} already exists`));
      }
      console.log();
      console.log(`To overwrite: ${chalk.cyan("vm0 init --force")}`);
      process.exit(1);
    }

    // Get agent name from option or prompt
    let agentName: string;
    if (options.name) {
      agentName = options.name.trim();
    } else {
      try {
        agentName = await promptAgentName();
      } catch {
        process.exit(0);
      }
    }

    // Validate agent name
    if (!agentName || !validateAgentName(agentName)) {
      console.log(chalk.red("✗ Invalid agent name"));
      console.log(
        chalk.gray("  Must be 3-64 characters, alphanumeric and hyphens only"),
      );
      console.log(chalk.gray("  Must start and end with letter or number"));
      process.exit(1);
    }

    // Write vm0.yaml
    await writeFile(VM0_YAML_FILE, generateVm0Yaml(agentName));
    const vm0Status = existingFiles.includes(VM0_YAML_FILE)
      ? " (overwritten)"
      : "";
    console.log(chalk.green(`✓ Created ${VM0_YAML_FILE}${vm0Status}`));

    // Write AGENTS.md
    await writeFile(AGENTS_MD_FILE, generateAgentsMd());
    const agentsStatus = existingFiles.includes(AGENTS_MD_FILE)
      ? " (overwritten)"
      : "";
    console.log(chalk.green(`✓ Created ${AGENTS_MD_FILE}${agentsStatus}`));

    // Print next steps
    console.log();
    console.log("Next steps:");
    console.log(
      `  1. Get your Claude Code token: ${chalk.cyan("claude setup-token")}`,
    );
    console.log(`  2. Set the environment variable (or add to .env file):`);
    console.log(chalk.gray(`     export CLAUDE_CODE_OAUTH_TOKEN=<your-token>`));
    console.log(`  3. Run your agent: ${chalk.cyan('vm0 cook "your prompt"')}`);
  });
