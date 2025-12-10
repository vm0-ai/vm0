import { Command } from "commander";
import chalk from "chalk";
import { authenticate, logout, checkAuthStatus } from "./lib/auth";
import { getApiUrl } from "./lib/config";
import { composeCommand } from "./commands/compose";
import { runCommand } from "./commands/run";
import { volumeCommand } from "./commands/volume";
import { artifactCommand } from "./commands/artifact";
import { secretCommand } from "./commands/secret";
import { cookCommand } from "./commands/cook";
import { imageCommand } from "./commands/image";
import { logsCommand } from "./commands/logs";

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
    console.log(chalk.cyan("System Information:"));
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

// Register compose, run, volume, artifact, secret, cook, image, and logs commands
program.addCommand(composeCommand);
program.addCommand(runCommand);
program.addCommand(volumeCommand);
program.addCommand(artifactCommand);
program.addCommand(secretCommand);
program.addCommand(cookCommand);
program.addCommand(imageCommand);
program.addCommand(logsCommand);

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  program.parse();
}
