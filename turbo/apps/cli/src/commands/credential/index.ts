import { Command } from "commander";
import { listCommand } from "./list";
import { setCommand } from "./set";
import { deleteCommand } from "./delete";

export const credentialCommand = new Command()
  .name("experimental-credential")
  .description("[Experimental] Manage stored credentials for agent runs")
  .addCommand(listCommand)
  .addCommand(setCommand)
  .addCommand(deleteCommand);
