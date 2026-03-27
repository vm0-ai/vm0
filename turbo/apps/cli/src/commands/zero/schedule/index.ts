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
  Create a daily schedule:   zero schedule setup <agent-id> -f daily -t 09:00 -p "run report"
  Create a loop schedule:    zero schedule setup <agent-id> -f loop -i 300 -p "poll for updates"
  Check all schedules:       zero schedule list
  Pause a schedule:          zero schedule disable <agent-id>
  Resume a schedule:         zero schedule enable <agent-id>

Notes:
  - setup is idempotent — re-running it with the same agent updates the existing schedule
  - Schedules are created disabled by default; use --enable or enable separately`,
  );
