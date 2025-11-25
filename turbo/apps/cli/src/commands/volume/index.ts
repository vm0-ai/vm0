import { Command } from "commander";
import { initCommand } from "./init";
import { pushCommand } from "./push";
import { pullCommand } from "./pull";

export const volumeCommand = new Command()
  .name("volume")
  .description("Manage cloud volumes")
  .addCommand(initCommand)
  .addCommand(pushCommand)
  .addCommand(pullCommand);
