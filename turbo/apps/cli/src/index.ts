import { Command } from "commander";
import chalk from "chalk";
import {
  authenticate,
  logout,
  checkAuthStatus,
  setupToken,
} from "./lib/api/auth";
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
import { setupGithubCommand } from "./commands/setup-github";
import { scheduleCommand } from "./commands/schedule";
import { usageCommand } from "./commands/usage";
import { credentialCommand } from "./commands/credential";
import { modelProviderCommand } from "./commands/model-provider";

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("vm0")
  .description("VM0 CLI - A modern build tool")
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

const authCommand = program
  .command("auth")
  .description("Authentication commands");

authCommand
  .command("login")
  .description("Log in to VM0 (use VM0_API_URL env var to set API URL)")
  .action(async () => {
    await authenticate();
  });

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
program.addCommand(setupGithubCommand);
program.addCommand(scheduleCommand);
program.addCommand(usageCommand);
program.addCommand(credentialCommand);
program.addCommand(modelProviderCommand);

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  program.parse();
}
