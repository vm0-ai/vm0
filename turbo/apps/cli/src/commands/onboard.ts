import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getToken } from "../lib/api/config";
import { authenticate } from "../lib/api/auth";
import { listModelProviders } from "../lib/api";
import { isInteractive } from "../lib/utils/prompt-utils";
import { setupClaudeCommand } from "./setup-claude";

const DEMO_AGENT_DIR = "vm0-demo-agent";
const DEMO_AGENT_NAME = "vm0-demo-agent";

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

export const onboardCommand = new Command()
  .name("onboard")
  .description("Guided setup for new VM0 users")
  .option("-y, --yes", "Skip confirmation prompts")
  .option(
    "--method <method>",
    "Agent building method: claude or manual",
    undefined,
  )
  .action(async (options: { yes?: boolean; method?: "claude" | "manual" }) => {
    // Step 1: Check auth
    const token = await getToken();
    if (token) {
      console.log(chalk.green("Done Authenticated"));
    } else {
      console.log(chalk.dim("Authentication required..."));
      console.log();
      await authenticate();
    }

    // Step 2: Check model-provider
    try {
      const result = await listModelProviders();
      if (result.modelProviders.length > 0) {
        console.log(chalk.green("Done Model provider configured"));
      } else {
        console.log(chalk.yellow("! No model provider configured"));
        console.log();
        console.log("Run the following to set up:");
        console.log(chalk.cyan("  vm0 model-provider setup"));
        console.log();
      }
    } catch {
      // Not authenticated or error - show warning but continue
      console.log(chalk.yellow("! Could not check model provider status"));
      console.log();
    }

    // Step 3: Create demo agent
    let createAgent = options.yes;
    if (!createAgent && isInteractive()) {
      const response = await prompts(
        {
          type: "confirm",
          name: "create",
          message: `Create ${DEMO_AGENT_DIR}?`,
          initial: true,
        },
        { onCancel: () => process.exit(0) },
      );
      createAgent = response.create;
    }

    if (!createAgent) {
      console.log(chalk.dim("Skipped agent creation"));
      return;
    }

    // Check if directory exists
    if (existsSync(DEMO_AGENT_DIR)) {
      console.log(chalk.red(`x ${DEMO_AGENT_DIR}/ already exists`));
      console.log();
      console.log("Remove it first or use a different directory:");
      console.log(chalk.cyan(`  rm -rf ${DEMO_AGENT_DIR}`));
      process.exit(1);
    }

    // Create directory
    await mkdir(DEMO_AGENT_DIR, { recursive: true });

    // Create files in the new directory
    const vm0YamlPath = path.join(DEMO_AGENT_DIR, "vm0.yaml");
    const agentsMdPath = path.join(DEMO_AGENT_DIR, "AGENTS.md");

    await writeFile(vm0YamlPath, generateVm0Yaml(DEMO_AGENT_NAME));
    await writeFile(agentsMdPath, generateAgentsMd());

    console.log(chalk.green(`Done Created ${vm0YamlPath}`));
    console.log(chalk.green(`Done Created ${agentsMdPath}`));
    console.log();

    // Step 4: Choose method
    let method = options.method;
    if (!method && isInteractive()) {
      const response = await prompts(
        {
          type: "select",
          name: "method",
          message: "How would you like to build your agent?",
          choices: [
            {
              title: "Use `vm0 setup-claude` to let Claude help (Recommended)",
              value: "claude",
            },
            {
              title: "I will do it myself (Edit `AGENTS.md` and `vm0.yaml`)",
              value: "manual",
            },
          ],
        },
        { onCancel: () => process.exit(0) },
      );
      method = response.method as "claude" | "manual";
    }

    if (method === "claude") {
      // Change to the demo agent directory and run setup-claude
      const originalDir = process.cwd();
      process.chdir(DEMO_AGENT_DIR);

      try {
        // Run setup-claude action directly
        await setupClaudeCommand.parseAsync([], { from: "user" });
      } finally {
        process.chdir(originalDir);
      }
    } else {
      console.log("Next steps:");
      console.log(`  1. ${chalk.cyan(`cd ${DEMO_AGENT_DIR}`)}`);
      console.log(
        `  2. Edit ${chalk.cyan("AGENTS.md")} to define your agent's workflow`,
      );
      console.log(`  3. Edit ${chalk.cyan("vm0.yaml")} to configure skills`);
      console.log(`  4. Run ${chalk.cyan('vm0 cook "start working"')} to test`);
    }
  });
