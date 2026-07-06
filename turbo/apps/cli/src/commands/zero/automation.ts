import { Command } from "commander";
import chalk from "chalk";

// The automation command tree was removed with the automation -> workflow
// migration (#19959 / #20100): scheduled tasks are workflow triggers now.
// This stub keeps `zero automation ...` from failing with an opaque
// unknown-command error and points at the replacement instead.
const REMOVAL_NOTICE = [
  "The automation commands were removed: scheduled tasks are workflow triggers now.",
  "",
  `Manage them with ${chalk.cyan("zero workflow")}, for example:`,
  `  ${chalk.cyan('zero workflow trigger add <workflow> cron --expr "0 9 * * *"')}`,
  `  ${chalk.cyan("zero workflow trigger list")}`,
  `  ${chalk.cyan("zero workflow --help")}`,
].join("\n");

export const zeroAutomationCommand = new Command("automation")
  .description("(removed: use `zero workflow`) Automations are workflows now")
  .helpOption(false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument("[args...]")
  .action(() => {
    console.error(REMOVAL_NOTICE);
    process.exitCode = 1;
  });
