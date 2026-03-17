import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { removeCommand } from "./remove";

export const orgVariableCommand = new Command()
  .name("variable")
  .description("Manage org-level variables (admin)")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(removeCommand);
