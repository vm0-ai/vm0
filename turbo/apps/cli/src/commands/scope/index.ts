import { Command } from "commander";
import { statusCommand } from "./status";
import { setCommand } from "./set";
import { listCommand } from "./list";
import { useCommand } from "./use";
import { orgCommand } from "./org/index";

const isOrgEnabled = process.env.VM0_EXPERIMENTAL_ORG_SCOPE === "1";

export const scopeCommand = new Command()
  .name("scope")
  .description("Manage your scope (namespace for agents)")
  .addCommand(statusCommand)
  .addCommand(setCommand);

if (isOrgEnabled) {
  scopeCommand.addCommand(listCommand);
  scopeCommand.addCommand(useCommand);
  scopeCommand.addCommand(orgCommand);
}
