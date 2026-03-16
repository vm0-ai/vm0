import { Command } from "commander";
import { cloneCommand } from "./clone";
import { deleteCommand } from "./delete";
import { listCommand } from "./list";
import { statusCommand } from "./status";

export const agentCommand = new Command()
  .name("agent")
  .description("Manage agent composes")
  .addCommand(cloneCommand)
  .addCommand(deleteCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand);
