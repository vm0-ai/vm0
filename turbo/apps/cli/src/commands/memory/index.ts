import { Command } from "commander";
import { initCommand } from "./init";
import { pushCommand } from "./push";
import { pullCommand } from "./pull";
import { statusCommand } from "./status";
import { listCommand } from "./list";
import { cloneCommand } from "./clone";

export const memoryCommand = new Command()
  .name("memory")
  .description("Manage agent long-term memory")
  .addCommand(initCommand)
  .addCommand(pushCommand)
  .addCommand(pullCommand)
  .addCommand(statusCommand)
  .addCommand(listCommand)
  .addCommand(cloneCommand);
