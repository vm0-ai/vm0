import { Command } from "commander";
import chalk from "chalk";

// The schedule command tree was removed in #17307: schedules are Automations
// now. This stub keeps `zero schedule ...` from failing with an opaque
// unknown-command error and points at the replacement instead.
const RENAME_NOTICE = [
  "The schedule commands were renamed: schedules are Automations now.",
  "",
  `Manage them with ${chalk.cyan("zero automation")}, for example:`,
  `  ${chalk.cyan('zero automation create -n alerts --agent <agent-id> -p "<instruction>" --cron "0 9 * * *"')}`,
  `  ${chalk.cyan("zero automation list")}`,
  `  ${chalk.cyan("zero automation --help")}`,
].join("\n");

export const zeroScheduleCommand = new Command("schedule")
  .description("(removed: use `zero automation`) Schedules are Automations now")
  .helpOption(false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument("[args...]")
  .action(() => {
    console.error(RENAME_NOTICE);
    process.exitCode = 1;
  });
