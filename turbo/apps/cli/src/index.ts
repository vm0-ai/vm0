import { Command } from "commander";
import { createCommand } from "./commands/create";
import { runCommand } from "./commands/run";
import chalk from "chalk";
import { authenticate, logout, checkAuthStatus } from "./lib/auth";
import { getApiUrl } from "./lib/config";
import { FOO } from "@vm0/core";

const program = new Command();

program
  .name("vm0")
  .description("VM0 CLI - Manage and run AI agents")
  .version("0.2.0");

// vm0 create command
program
  .command("create <config-file>")
  .description("Create an agent config from a YAML file")
  .option("--json", "Output JSON format")
  .action(createCommand);

// vm0 run command
program
  .command("run <agent-config-id> <prompt>")
  .description("Run an agent with a prompt")
  .option("--dynamicVars <json>", "Dynamic variables as JSON string")
  .option("--json", "Output JSON format")
  .option("--verbose", "Show detailed information")
  .action(runCommand);

// vm0 hello command
program
  .command("hello")
  .description("Say hello from the App")
  .action(() => {
    console.log(chalk.blue("Welcome to the VM0 CLI!"));
    console.log(chalk.green(`Core says: ${FOO}`));
  });

// vm0 info command
program
  .command("info")
  .description("Display environment information")
  .action(async () => {
    console.log(chalk.cyan("System Information:"));
    console.log(`Node Version: ${process.version}`);
    console.log(`Platform: ${process.platform}`);
    console.log(`Architecture: ${process.arch}`);
    const apiUrl = await getApiUrl();
    console.log(`API Host: ${apiUrl ?? "Not configured"}`);
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

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  program.parse();
}
