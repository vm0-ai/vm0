import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const zeroVariableCommand = new Command()
  .name("variable")
  .description("Read or write non-sensitive configuration values")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
