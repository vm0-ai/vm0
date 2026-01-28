// CI trigger: issue #1522 - simplify model-provider e2e tests
import { Command } from "commander";
import chalk from "chalk";
import { logout, checkAuthStatus, setupToken } from "./lib/api/auth";
import { loginCommand } from "./commands/auth";
import { getApiUrl } from "./lib/api/config";
import { composeCommand } from "./commands/compose";
import { runCommand } from "./commands/run";
import { volumeCommand } from "./commands/volume";
import { artifactCommand } from "./commands/artifact";
import { cookCommand } from "./commands/cook";
import { logsCommand } from "./commands/logs";
import { scopeCommand } from "./commands/scope";
import { agentCommand } from "./commands/agent";
import { initCommand } from "./commands/init";
import { scheduleCommand } from "./commands/schedule";
import { usageCommand } from "./commands/usage";
import { credentialCommand } from "./commands/credential";
import { modelProviderCommand } from "./commands/model-provider";
import { onboardCommand } from "./commands/onboard";
import { setupClaudeCommand } from "./commands/setup-claude";

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("vm0")
  .description("VM0 CLI - Build and run agents with natural language")
  .version(__CLI_VERSION__);

program
  .command("info")
  .description("Display environment information")
  .action(async () => {
    console.log(chalk.bold("System Information:"));
    console.log(`Node Version: ${process.version}`);
    console.log(`Platform: ${process.platform}`);
    console.log(`Architecture: ${process.arch}`);
    const apiUrl = await getApiUrl();
    console.log(`API Host: ${apiUrl}`);
  });

const authCommand = program.command("auth").description("Authenticate vm0");

authCommand.addCommand(loginCommand);

authCommand
  .command("logout")
  .description("Log out of VM0")
  .action(async () => {
    await logout();
  });

authCommand
  .command("status")
  .description("Show current authentication status")
  .action(async () => {
    await checkAuthStatus();
  });

authCommand
  .command("setup-token")
  .description("Output auth token for CI/CD environments")
  .action(async () => {
    await setupToken();
  });

// Register all subcommands
program.addCommand(composeCommand);
program.addCommand(runCommand);
program.addCommand(volumeCommand);
program.addCommand(artifactCommand);
program.addCommand(cookCommand);
program.addCommand(logsCommand);
program.addCommand(scopeCommand);
program.addCommand(agentCommand);
program.addCommand(initCommand);
program.addCommand(scheduleCommand);
program.addCommand(usageCommand);
program.addCommand(credentialCommand);
program.addCommand(modelProviderCommand);
program.addCommand(onboardCommand);
program.addCommand(setupClaudeCommand);

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  program.parse();
}
