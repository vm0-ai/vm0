import { Command } from "commander";
import { createCommand } from "./create";
import { listCommand } from "./list";
import { showCommand } from "./show";
import { updateCommand } from "./update";
import { deleteCommand } from "./delete";
import { enableCommand } from "./enable";
import { disableCommand } from "./disable";
import { runCommand } from "./run";
import { triggerCommand } from "./trigger";

export const zeroAutomationCommand = new Command()
  .name("automation")
  .description("Create or manage automations and their triggers")
  .addCommand(createCommand)
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(updateCommand)
  .addCommand(deleteCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(runCommand)
  .addCommand(triggerCommand)
  // Deprecated aliases — fully functional, but print a stderr notice pointing
  // at the replacement command.
  .addHelpText(
    "after",
    `
Examples:
  Create an automation:   zero automation create -n alerts --agent <agent-id> -p "Summarize alerts" --cron "0 9 * * *"
  List automations:       zero automation list
  Inspect one:            zero automation show alerts
  Fire manually:          zero automation run alerts
  Manage triggers:        zero automation trigger --help
  Pause an automation:    zero automation disable alerts
  Resume an automation:   zero automation enable alerts
  Delete an automation:   zero automation delete alerts`,
  );
