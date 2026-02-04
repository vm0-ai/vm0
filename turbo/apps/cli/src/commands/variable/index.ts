import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const variableCommand = new Command()
  .name("variable")
  .description("Manage stored variables for agent runs")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
