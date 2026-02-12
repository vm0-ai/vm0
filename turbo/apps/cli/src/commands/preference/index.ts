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
 * Parse on/off flag value
 */
function parseOnOff(flag: string, value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "on" || lower === "true" || lower === "1") return true;
  if (lower === "off" || lower === "false" || lower === "0") return false;
  throw new Error(
    `Invalid value for --${flag}: "${value}". Use "on" or "off".`,
  );
}

/**
 * Display current preferences
 */
function displayPreferences(prefs: {
  timezone: string | null;
  notifyEmail: boolean;
  notifySlack: boolean;
}): void {
  console.log(chalk.bold("Current preferences:"));
  console.log(
    `  Timezone:      ${prefs.timezone ? chalk.cyan(prefs.timezone) : chalk.dim("not set")}`,
  );
  console.log(
    `  Email notify:  ${prefs.notifyEmail ? chalk.green("on") : chalk.dim("off")}`,
  );
  console.log(
    `  Slack notify:  ${prefs.notifySlack ? chalk.green("on") : chalk.dim("off")}`,
  );
}

interface PreferenceOpts {
  timezone?: string;
  notifyEmail?: string;
  notifySlack?: string;
}

/**
 * Build updates from CLI flags, exiting on invalid input
 */
function buildUpdates(opts: PreferenceOpts): {
  timezone?: string;
  notifyEmail?: boolean;
  notifySlack?: boolean;
} | null {
  const hasTimezone = opts.timezone !== undefined;
  const hasNotifyEmail = opts.notifyEmail !== undefined;
  const hasNotifySlack = opts.notifySlack !== undefined;

  if (!hasTimezone && !hasNotifyEmail && !hasNotifySlack) return null;

  const updates: {
    timezone?: string;
    notifyEmail?: boolean;
    notifySlack?: boolean;
  } = {};

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
      updates.notifyEmail = parseOnOff("notify-email", opts.notifyEmail!);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  }

  if (hasNotifySlack) {
    try {
      updates.notifySlack = parseOnOff("notify-slack", opts.notifySlack!);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  }

  return updates;
}

/**
 * Print confirmation after a successful update
 */
function printUpdateResult(
  updates: { timezone?: string; notifyEmail?: boolean; notifySlack?: boolean },
  result: {
    timezone: string | null;
    notifyEmail: boolean;
    notifySlack: boolean;
  },
): void {
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
  if (updates.notifySlack !== undefined) {
    console.log(
      chalk.green(
        `Slack notifications ${result.notifySlack ? "enabled" : "disabled"}`,
      ),
    );
  }
}

/**
 * Interactive prompts when no flags provided
 */
async function interactiveSetup(prefs: {
  timezone: string | null;
  notifyEmail: boolean;
}): Promise<void> {
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
      console.log(chalk.green(`Timezone set to ${chalk.cyan(tz.trim())}`));
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
}

/**
 * vm0 preference
 *
 * View or update user preferences (timezone, notifications).
 */
export const preferenceCommand = new Command()
  .name("preference")
  .description("View or update your preferences")
  .option("--timezone <timezone>", "IANA timezone (e.g., America/New_York)")
  .option("--notify-email <on|off>", "Enable or disable email notifications")
  .option("--notify-slack <on|off>", "Enable or disable Slack notifications")
  .action(
    withErrorHandler(async (opts: PreferenceOpts) => {
      const updates = buildUpdates(opts);

      if (updates) {
        const result = await updateUserPreferences(updates);
        printUpdateResult(updates, result);
        return;
      }

      // No flags: display current preferences
      const prefs = await getUserPreferences();
      displayPreferences(prefs);

      if (isInteractive()) {
        await interactiveSetup(prefs);
      } else if (!prefs.timezone) {
        console.log();
        console.log(
          `To set timezone: ${chalk.cyan("vm0 preference --timezone <timezone>")}`,
        );
        console.log(
          chalk.dim("Example: vm0 preference --timezone America/New_York"),
        );
      }
    }),
  );
