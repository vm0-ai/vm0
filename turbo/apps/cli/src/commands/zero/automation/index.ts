import { Command } from "commander";
import { setupCommand } from "./setup";
import { listCommand } from "./list";
import { statusCommand } from "./status";
import { deleteCommand } from "./delete";
import { enableCommand } from "./enable";
import { disableCommand } from "./disable";
import { webhookCommand } from "./webhook";

export const zeroAutomationCommand = new Command()
  .name("automation")
  .description("Create or manage automations")
  .addCommand(setupCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addCommand(deleteCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(webhookCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create an automation:     zero automation setup --help
  Check all automations:    zero automation list
  Check automation status:  zero automation status <agent-id>
  Pause an automation:      zero automation disable <agent-id>
  Resume an automation:     zero automation enable <agent-id>
  Delete an automation:     zero automation delete <agent-id>
  Webhook-triggered:        zero automation webhook --help`,
  );
