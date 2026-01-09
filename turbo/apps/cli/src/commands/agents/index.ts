import { Command } from "commander";
import { listCommand } from "./list";
import { inspectCommand } from "./inspect";

export const agentsCommand = new Command()
  .name("agents")
  .description("Manage agent composes")
  .addCommand(listCommand)
  .addCommand(inspectCommand);
