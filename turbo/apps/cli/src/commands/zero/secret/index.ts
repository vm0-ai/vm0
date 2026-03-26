import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const zeroSecretCommand = new Command()
  .name("secret")
  .description("Read or write secrets (API keys, tokens)")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
