import { Command } from "commander";
import { buildCommand } from "./build";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";

export const imageCommand = new Command()
  .name("image")
  .description("Manage custom images")
  .addCommand(buildCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand);
