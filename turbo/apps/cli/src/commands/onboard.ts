import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { getToken } from "../lib/api/config";
import { listModelProviders } from "../lib/api";
import { isInteractive } from "../lib/utils/prompt-utils";
import { loginCommand } from "./auth";
import { setupCommand as modelProviderSetupCommand } from "./model-provider/setup";
import { setupClaudeCommand } from "./setup-claude";
import { initCommand } from "./init";

const DEMO_AGENT_DIR = "vm0-demo-agent";
const DEMO_AGENT_NAME = "vm0-demo-agent";

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
      await loginCommand.parseAsync([], { from: "user" });
    }

    // Step 2: Check/setup model-provider
    try {
      const result = await listModelProviders();
      if (result.modelProviders.length > 0) {
        console.log(chalk.green("Done Model provider configured"));
      } else {
        console.log(chalk.dim("Model provider setup required..."));
        console.log();
        await modelProviderSetupCommand.parseAsync([], { from: "user" });
      }
    } catch {
      // If we can't check, try to run setup anyway
      // setupCommand will handle its own errors
      console.log(chalk.dim("Setting up model provider..."));
      console.log();
      await modelProviderSetupCommand.parseAsync([], { from: "user" });
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

    // Create directory and run init inside it
    await mkdir(DEMO_AGENT_DIR, { recursive: true });

    const originalDir = process.cwd();
    process.chdir(DEMO_AGENT_DIR);

    try {
      // Use vm0 init to create the project files
      await initCommand.parseAsync(["--name", DEMO_AGENT_NAME], {
        from: "user",
      });
    } finally {
      process.chdir(originalDir);
    }

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
      process.chdir(DEMO_AGENT_DIR);

      try {
        // Run setup-claude action directly, passing agent-dir for the "Next step" message
        await setupClaudeCommand.parseAsync(["--agent-dir", DEMO_AGENT_DIR], {
          from: "user",
        });
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
