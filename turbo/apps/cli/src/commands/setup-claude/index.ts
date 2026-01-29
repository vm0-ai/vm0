import { Command } from "commander";
import chalk from "chalk";
import {
  installVm0Plugin,
  handlePluginError,
  PRIMARY_SKILL_NAME,
  type PluginScope,
} from "../../lib/domain/onboard/index.js";

export const setupClaudeCommand = new Command()
  .name("setup-claude")
  .description("Install VM0 Claude Plugin")
  .option("--agent-dir <dir>", "Agent directory to run install in")
  .option("--scope <scope>", "Installation scope (user or project)", "project")
  .action(async (options: { agentDir?: string; scope?: string }) => {
    console.log(chalk.dim("Installing VM0 Claude Plugin..."));

    const scope = (
      options.scope === "user" ? "user" : "project"
    ) as PluginScope;

    try {
      const result = await installVm0Plugin(scope, options.agentDir);
      console.log(
        chalk.green(`✓ Installed ${result.pluginId} (scope: ${result.scope})`),
      );
    } catch (error) {
      handlePluginError(error);
    }

    console.log();
    console.log("Next step:");
    const cdPrefix = options.agentDir ? `cd ${options.agentDir} && ` : "";
    console.log(
      chalk.cyan(
        `  ${cdPrefix}claude "/${PRIMARY_SKILL_NAME} let's build a workflow"`,
      ),
    );
  });
