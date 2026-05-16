import { Command } from "commander";
import { createListCommand } from "../org/model-provider/list";
import { createSetupCommand } from "../org/model-provider/setup";
import { createRemoveCommand } from "../org/model-provider/remove";

export const zeroModelCommand = new Command()
  .name("model")
  .description("Manage workspace model providers and BYOK settings")
  .addCommand(
    createListCommand({
      scopeLabel: "workspace",
      title: "Workspace Model Providers",
      setupCommand: "zero model setup",
    }),
  )
  .addCommand(
    createSetupCommand({
      commandPrefix: "zero model setup",
      description: "Configure a workspace model provider",
      scopeLabel: "Workspace",
    }),
  )
  .addCommand(createRemoveCommand({ scopeLabel: "Workspace" }));
