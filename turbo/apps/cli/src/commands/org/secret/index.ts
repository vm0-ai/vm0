import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { removeCommand } from "./remove";

export const orgSecretCommand = new Command()
  .name("secret")
  .description("Manage org-level secrets (admin)")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(removeCommand);
