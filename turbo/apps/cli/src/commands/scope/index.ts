import { Command } from "commander";
import { statusCommand } from "./status";
import { setCommand } from "./set";

export const scopeCommand = new Command()
  .name("scope")
  .description("Manage your scope (namespace for images)")
  .addCommand(statusCommand)
  .addCommand(setCommand);
