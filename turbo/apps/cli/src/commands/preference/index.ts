import { Command } from "commander";
import chalk from "chalk";
import { getUserPreferences, updateUserPreferences } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";
import {
  isInteractive,
  promptText,
  promptConfirm,
} from "../../lib/utils/prompt-utils";

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
 * Parse --notify-email flag value (on/off)
 */
function parseNotifyEmail(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "on" || lower === "true" || lower === "1") return true;
  if (lower === "off" || lower === "false" || lower === "0") return false;
  throw new Error(
    `Invalid value for --notify-email: "${value}". Use "on" or "off".`,
  );
}

/**
 * Display current preferences
 */
function displayPreferences(prefs: {
  timezone: string | null;
  notifyEmail: boolean;
}): void {
  console.log(chalk.bold("Current preferences:"));
  console.log(
    `  Timezone:      ${prefs.timezone ? chalk.cyan(prefs.timezone) : chalk.dim("not set")}`,
  );
  console.log(
    `  Email notify:  ${prefs.notifyEmail ? chalk.green("on") : chalk.dim("off")}`,
  );
}

/**
 * vm0 preference
 *
 * View or update user preferences (timezone, email notifications).
 */
export const preferenceCommand = new Command()
  .name("preference")
  .description("View or update your preferences")
  .option("--timezone <timezone>", "IANA timezone (e.g., America/New_York)")
  .option("--notify-email <on|off>", "Enable or disable email notifications")
  .action(
    withErrorHandler(
      async (opts: { timezone?: string; notifyEmail?: string }) => {
        const hasTimezone = opts.timezone !== undefined;
        const hasNotifyEmail = opts.notifyEmail !== undefined;

        // If flags provided, update preferences
        if (hasTimezone || hasNotifyEmail) {
          const updates: { timezone?: string; notifyEmail?: boolean } = {};

          if (hasTimezone) {
            if (!isValidTimezone(opts.timezone!)) {
              console.error(chalk.red(`Invalid timezone: ${opts.timezone}`));
              console.error(
                chalk.dim(
                  "  Use an IANA timezone identifier (e.g., America/New_York, Asia/Shanghai)",
                ),
              );
              process.exit(1);
            }
            updates.timezone = opts.timezone;
          }

          if (hasNotifyEmail) {
            try {
              updates.notifyEmail = parseNotifyEmail(opts.notifyEmail!);
            } catch (err) {
              console.error(chalk.red((err as Error).message));
              process.exit(1);
            }
          }

          const result = await updateUserPreferences(updates);

          if (updates.timezone !== undefined) {
            console.log(
              chalk.green(
                `Timezone set to ${chalk.cyan(result.timezone ?? updates.timezone)}`,
              ),
            );
          }
          if (updates.notifyEmail !== undefined) {
            console.log(
              chalk.green(
                `Email notifications ${result.notifyEmail ? "enabled" : "disabled"}`,
              ),
            );
          }
          return;
        }

        // No flags: display current preferences
        const prefs = await getUserPreferences();
        displayPreferences(prefs);

        // Interactive mode: offer to change settings
        if (isInteractive()) {
          if (!prefs.timezone) {
            const detectedTz = detectTimezone();
            console.log(chalk.dim(`\nSystem timezone detected: ${detectedTz}`));
            const tz = await promptText(
              "Set timezone? (enter timezone or leave empty to skip)",
              detectedTz,
            );
            if (tz?.trim()) {
              if (!isValidTimezone(tz.trim())) {
                console.error(chalk.red(`Invalid timezone: ${tz.trim()}`));
                process.exit(1);
              }
              await updateUserPreferences({ timezone: tz.trim() });
              console.log(
                chalk.green(`Timezone set to ${chalk.cyan(tz.trim())}`),
              );
            }
          }

          if (!prefs.notifyEmail) {
            const enable = await promptConfirm(
              "\nEnable email notifications for scheduled runs?",
              false,
            );
            if (enable) {
              await updateUserPreferences({ notifyEmail: true });
              console.log(chalk.green("Email notifications enabled"));
            }
          }
        } else if (!prefs.timezone) {
          console.log();
          console.log(
            `To set timezone: ${chalk.cyan("vm0 preference --timezone <timezone>")}`,
          );
          console.log(
            chalk.dim("Example: vm0 preference --timezone America/New_York"),
          );
        }
      },
    ),
  );
