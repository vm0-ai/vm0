import { Command } from "commander";
import { setCommand } from "./set";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";

export const secretCommand = new Command()
  .name("secret")
  .description("Manage secrets for agent compose configurations")
  .addCommand(setCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand);
