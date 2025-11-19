import { FOO } from "@vm0/core";
import { Command } from "commander";
import chalk from "chalk";
import { authenticate, logout, checkAuthStatus } from "./lib/auth";
import { getApiUrl } from "./lib/config";
import { buildCommand } from "./commands/build";
import { runCommand } from "./commands/run";

const program = new Command();

program
  .name("vm0")
  .description("VM0 CLI - A modern build tool")
  .version("0.1.0");

program
  .command("hello")
  .description("Say hello from the App")
  .action(() => {
    console.log(chalk.blue("Welcome to the VM0 CLI!"));
    console.log(chalk.green(`Core says: ${FOO}`));
  });

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
  .description("Log in to VM0 (use API_HOST env var to set API URL)")
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

// Register build and run commands
program.addCommand(buildCommand);
program.addCommand(runCommand);

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  program.parse();
}
