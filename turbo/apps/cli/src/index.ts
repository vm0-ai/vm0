import { Command } from "commander";
import { createCommand } from "./commands/create";
import { runCommand } from "./commands/run";

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

program.parse();
