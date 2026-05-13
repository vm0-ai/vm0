import { Command } from "commander";
import { listCommand } from "./list";
import { setupCommand } from "./setup";
import { removeCommand } from "./remove";

export const zeroOrgModelProviderCommand = new Command()
  .name("model-provider")
  .description("Manage org-level model providers")
  .addCommand(listCommand)
  .addCommand(setupCommand)
  .addCommand(removeCommand);
