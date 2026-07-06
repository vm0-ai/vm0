import { Command } from "commander";
import chalk from "chalk";

// The schedule command tree was removed in #17307 and its Automations
// successor was removed with the workflow migration (#19959 / #20100):
// scheduled tasks are workflow triggers now. This stub keeps
// `zero schedule ...` from failing with an opaque unknown-command error and
// points at the replacement instead.
const RENAME_NOTICE = [
  "The schedule commands were removed: scheduled tasks are workflow triggers now.",
  "",
  `Manage them with ${chalk.cyan("zero workflow")}, for example:`,
  `  ${chalk.cyan('zero workflow trigger add <workflow> cron --expr "0 9 * * *"')}`,
  `  ${chalk.cyan("zero workflow trigger list")}`,
  `  ${chalk.cyan("zero workflow --help")}`,
].join("\n");

export const zeroScheduleCommand = new Command("schedule")
  .description(
    "(removed: use `zero workflow`) Schedules are workflow triggers now",
  )
  .helpOption(false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument("[args...]")
  .action(() => {
    console.error(RENAME_NOTICE);
    process.exitCode = 1;
  });
