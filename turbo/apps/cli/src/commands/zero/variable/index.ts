import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const zeroVariableCommand = new Command()
  .name("variable")
  .description("Manage variables")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
