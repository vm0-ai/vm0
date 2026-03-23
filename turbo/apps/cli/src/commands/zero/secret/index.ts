import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const zeroSecretCommand = new Command()
  .name("secret")
  .description("Manage secrets")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
