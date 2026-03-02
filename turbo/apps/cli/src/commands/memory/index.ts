import { Command } from "commander";
import { listCommand } from "./list";
import { pullCommand } from "./pull";

export const memoryCommand = new Command()
  .name("memory")
  .description("Manage agent long-term memory")
  .addCommand(listCommand)
  .addCommand(pullCommand);
