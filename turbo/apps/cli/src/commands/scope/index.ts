import { Command } from "commander";
import { statusCommand } from "./status";
import { setCommand } from "./set";
import { listCommand } from "./list";
import { useCommand } from "./use";
import { orgCommand } from "./org";

export const scopeCommand = new Command()
  .name("scope")
  .description("Manage your scope (namespace for agents)")
  .addCommand(statusCommand)
  .addCommand(setCommand)
  .addCommand(listCommand)
  .addCommand(useCommand)
  .addCommand(orgCommand);
