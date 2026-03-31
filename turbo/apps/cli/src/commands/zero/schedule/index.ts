import { Command } from "commander";
import { setupCommand } from "./setup";
import { listCommand } from "./list";
import { statusCommand } from "./status";
import { deleteCommand } from "./delete";
import { enableCommand } from "./enable";
import { disableCommand } from "./disable";

export const zeroScheduleCommand = new Command()
  .name("schedule")
  .description("Create or manage recurring scheduled tasks")
  .addCommand(setupCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addCommand(deleteCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create a schedule:     zero schedule setup --help
  Check all schedules:   zero schedule list
  Check schedule status: zero schedule status <agent-id>
  Pause a schedule:      zero schedule disable <agent-id>
  Resume a schedule:     zero schedule enable <agent-id>
  Delete a schedule:     zero schedule delete <agent-id>`,
  );
