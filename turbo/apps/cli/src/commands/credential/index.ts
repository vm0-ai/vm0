import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const credentialCommand = new Command()
  .name("credential")
  .description("Manage stored credentials for agent runs")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
