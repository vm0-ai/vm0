import { Command } from "commander";
import chalk from "chalk";
import { getUserPreferences, updateUserPreferences } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";
import { isInteractive, promptText } from "../../lib/utils/prompt-utils";

/**
 * Detect system timezone using Intl API
 */
function detectTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Validate timezone using Intl.DateTimeFormat
 */
function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * vm0 timezone
 *
 * Show current timezone setting.
 */
export const timezoneCommand = new Command()
  .name("timezone")
  .description("View or set your timezone preference")
  .argument("[timezone]", "IANA timezone to set (e.g., America/New_York)")
  .action(
    withErrorHandler(async (timezone: string | undefined) => {
      if (timezone) {
        // Set timezone
        if (!isValidTimezone(timezone)) {
          console.error(chalk.red(`✗ Invalid timezone: ${timezone}`));
          console.error(
            chalk.dim(
              "  Use an IANA timezone identifier (e.g., America/New_York, Asia/Shanghai)",
            ),
          );
          process.exit(1);
        }

        const result = await updateUserPreferences({ timezone });
        console.log(chalk.green(`✓ Timezone set to ${chalk.cyan(timezone)}`));
        if (result.timezone !== timezone) {
          console.log(chalk.dim(`  (Server returned: ${result.timezone})`));
        }
        return;
      }

      // Show current timezone
      const prefs = await getUserPreferences();

      if (prefs.timezone) {
        console.log(`Current timezone: ${chalk.cyan(prefs.timezone)}`);
      } else {
        const detectedTz = detectTimezone();
        console.log(chalk.dim("No timezone preference set."));
        console.log(chalk.dim(`System timezone detected: ${detectedTz}`));

        if (isInteractive()) {
          const setNow = await promptText(
            "Would you like to set it now? (enter timezone or leave empty to skip)",
            detectedTz,
          );

          if (setNow && setNow.trim()) {
            const tz = setNow.trim();
            if (!isValidTimezone(tz)) {
              console.error(chalk.red(`✗ Invalid timezone: ${tz}`));
              process.exit(1);
            }
            await updateUserPreferences({ timezone: tz });
            console.log(chalk.green(`✓ Timezone set to ${chalk.cyan(tz)}`));
          }
        } else {
          console.log();
          console.log(
            `To set your timezone: ${chalk.cyan("vm0 timezone <timezone>")}`,
          );
          console.log(chalk.dim("Example: vm0 timezone America/New_York"));
        }
      }
    }),
  );
