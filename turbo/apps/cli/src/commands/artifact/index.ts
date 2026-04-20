import { Command } from "commander";
import { initCommand } from "./init";
import { pushCommand } from "./push";
import { pullCommand } from "./pull";
import { statusCommand } from "./status";
import { listCommand } from "./list";
import { cloneCommand } from "./clone";

export const artifactCommand = new Command()
  .name("artifact")
  .description("Manage artifacts (specified at run, versioned after run)")
  .addCommand(initCommand)
  .addCommand(pushCommand)
  .addCommand(pullCommand)
  .addCommand(statusCommand)
  .addCommand(listCommand)
  .addCommand(cloneCommand);
