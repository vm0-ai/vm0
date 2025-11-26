import { Command } from "commander";
import { initCommand } from "./init";
import { pushCommand } from "./push";
import { pullCommand } from "./pull";

export const artifactCommand = new Command()
  .name("artifact")
  .description("Manage cloud artifacts (work products)")
  .addCommand(initCommand)
  .addCommand(pushCommand)
  .addCommand(pullCommand);
