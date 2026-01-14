import { Command } from "commander";
import { initCommand } from "./init";
import { deployCommand } from "./deploy";
import { listCommand } from "./list";
import { statusCommand } from "./status";
import { deleteCommand } from "./delete";
import { enableCommand } from "./enable";
import { disableCommand } from "./disable";

export const scheduleCommand = new Command()
  .name("schedule")
  .description("Manage agent schedules")
  .addCommand(initCommand)
  .addCommand(deployCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addCommand(deleteCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand);
