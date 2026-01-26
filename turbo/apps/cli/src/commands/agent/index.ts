import { Command } from "commander";
import { listCommand } from "./list";
import { statusCommand } from "./status";

export const agentCommand = new Command()
  .name("agent")
  .description("Manage agent composes")
  .addCommand(listCommand)
  .addCommand(statusCommand);
