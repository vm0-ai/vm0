import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { validateAgentName } from "../../lib/domain/yaml-validator";
import { promptText, isInteractive } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command";

const VM0_YAML_FILE = "vm0.yaml";
const AGENTS_MD_FILE = "AGENTS.md";

function generateVm0Yaml(agentName: string): string {
  return `version: "1.0"

agents:
  ${agentName}:
    framework: claude-code
    # Build agentic workflow using natural language
    instructions: AGENTS.md
    # Agent skills - see https://github.com/vm0-ai/vm0-skills for available skills
    # skills:
    #   - https://github.com/vm0-ai/vm0-skills/tree/main/github
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

export const initCommand = new Command()
  .name("init")
  .description("Initialize a new VM0 project in the current directory")
  .option("-f, --force", "Overwrite existing files")
  .option("-n, --name <name>", "Agent name (required in non-interactive mode)")
  .action(
    withErrorHandler(async (options: { force?: boolean; name?: string }) => {
      // Check existing files
      const existingFiles = checkExistingFiles();
      if (existingFiles.length > 0 && !options.force) {
        throw new Error(`${existingFiles.join(", ")} already exists`, {
          cause: new Error("To overwrite: vm0 init --force"),
        });
      }

      // Get agent name from option or prompt
      let agentName: string;
      if (options.name) {
        agentName = options.name.trim();
      } else if (!isInteractive()) {
        throw new Error("--name flag is required in non-interactive mode", {
          cause: new Error("Usage: vm0 init --name <agent-name>"),
        });
      } else {
        // Use directory name as default suggestion
        const dirName = path.basename(process.cwd());
        const defaultName = validateAgentName(dirName) ? dirName : undefined;

        const name = await promptText(
          "Enter agent name",
          defaultName,
          (value: string) => {
            if (!validateAgentName(value)) {
              return "Must be 3-64 characters, alphanumeric and hyphens, start/end with letter or number";
            }
            return true;
          },
        );

        if (name === undefined) {
          // User cancelled
          console.log(chalk.dim("Cancelled"));
          return;
        }

        agentName = name;
      }

      // Validate agent name
      if (!agentName || !validateAgentName(agentName)) {
        throw new Error("Invalid agent name", {
          cause: new Error(
            "Must be 3-64 characters, alphanumeric and hyphens only, start and end with letter or number",
          ),
        });
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
      console.log(`  1. Log in to VM0: ${chalk.cyan("vm0 auth login")}`);
      console.log(
        `  2. Edit ${chalk.cyan("AGENTS.md")} to customize your agent's workflow`,
      );
      console.log(
        `  3. Run your agent: ${chalk.cyan('vm0 run --secrets CLAUDE_CODE_OAUTH_TOKEN=<token> "let\'s start working"')}`,
      );
    }),
  );
