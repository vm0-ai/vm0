import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const secretCommand = new Command()
  .name("secret")
  .description("Manage stored secrets for agent runs")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
