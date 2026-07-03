import { Command } from "commander";
import { createListCommand } from "./list";
import { createSetupCommand } from "./setup";
import { createRemoveCommand } from "./remove";

export const zeroOrgModelProviderCommand = new Command()
  .name("model-provider")
  .description("Manage org-level model providers")
  .addCommand(
    createListCommand({
      scopeLabel: "org-level",
      title: "Org Model Providers",
      setupCommand: "zero org model-provider setup",
    }),
  )
  .addCommand(
    createSetupCommand({
      commandPrefix: "zero org model-provider setup",
      description: "Configure an org-level model provider",
      scopeLabel: "Org",
    }),
  )
  .addCommand(createRemoveCommand({ scopeLabel: "Org" }));
