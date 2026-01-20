import { Command } from "commander";
import { listCommand } from "./list";
import { inspectCommand } from "./inspect";

export const agentCommand = new Command()
  .name("agent")
  .description("Manage agent composes")
  .addCommand(listCommand)
  .addCommand(inspectCommand);
