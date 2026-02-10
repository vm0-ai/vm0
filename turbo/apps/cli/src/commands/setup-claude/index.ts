import { Command } from "commander";
import chalk from "chalk";
import {
  installVm0Plugin,
  PRIMARY_SKILL_NAME,
  type PluginScope,
} from "../../lib/domain/onboard/index.js";
import { withErrorHandler } from "../../lib/command";

export const setupClaudeCommand = new Command()
  .name("setup-claude")
  .description("Install VM0 Claude Plugin")
  .option("--agent-dir <dir>", "Agent directory to run install in")
  .option("--scope <scope>", "Installation scope (user or project)", "project")
  .action(
    withErrorHandler(async (options: { agentDir?: string; scope?: string }) => {
      console.log(chalk.dim("Installing VM0 Claude Plugin..."));

      const scope = (
        options.scope === "user" ? "user" : "project"
      ) as PluginScope;

      const result = await installVm0Plugin(scope, options.agentDir);
      console.log(
        chalk.green(`✓ Installed ${result.pluginId} (scope: ${result.scope})`),
      );

      console.log();
      console.log("Next step:");
      const cdPrefix = options.agentDir ? `cd ${options.agentDir} && ` : "";
      console.log(
        chalk.cyan(
          `  ${cdPrefix}claude "/${PRIMARY_SKILL_NAME} let's build a workflow"`,
        ),
      );
    }),
  );
