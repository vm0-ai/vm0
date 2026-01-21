import { Command } from "commander";
import { listCommand } from "./list";
import { setupCommand } from "./setup";
import { deleteCommand } from "./delete";
import { setDefaultCommand } from "./set-default";

export const modelProviderCommand = new Command()
  .name("model-provider")
  .description("Manage model providers for agent runs")
  .addCommand(listCommand)
  .addCommand(setupCommand)
  .addCommand(deleteCommand)
  .addCommand(setDefaultCommand);
