import { Command } from "commander";
import { cloneCommand } from "./clone";
import { listCommand } from "./list";
import { statusCommand } from "./status";

export const agentCommand = new Command()
  .name("agent")
  .description("Manage agent composes")
  .addCommand(cloneCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand);
