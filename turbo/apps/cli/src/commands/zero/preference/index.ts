import { Command } from "commander";
import chalk from "chalk";
import {
  getZeroUserPreferences,
  updateZeroUserPreferences,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { isInteractive, promptText } from "../../../lib/utils/prompt-utils";

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
 * Display current preferences
 */
function displayPreferences(prefs: { timezone: string | null }): void {
  console.log(chalk.bold("Current preferences:"));
  console.log(
    `  Timezone:      ${prefs.timezone ? chalk.cyan(prefs.timezone) : chalk.dim("not set")}`,
  );
}

interface PreferenceOpts {
  timezone?: string;
}

/**
 * Build updates from CLI flags, exiting on invalid input
 */
function buildUpdates(opts: PreferenceOpts): { timezone?: string } | null {
  if (opts.timezone === undefined) return null;

  if (!isValidTimezone(opts.timezone)) {
    throw new Error(`Invalid timezone: ${opts.timezone}`, {
      cause: new Error(
        "Use an IANA timezone identifier (e.g., America/New_York, Asia/Shanghai)",
      ),
    });
  }

  return { timezone: opts.timezone };
}

/**
 * Print confirmation after a successful update
 */
function printUpdateResult(
  updates: { timezone?: string },
  result: { timezone: string | null },
): void {
  if (updates.timezone !== undefined) {
    console.log(
      chalk.green(
        `Timezone set to ${chalk.cyan(result.timezone ?? updates.timezone)}`,
      ),
    );
  }
}

/**
 * Interactive prompts when no flags provided
 */
async function interactiveSetup(prefs: {
  timezone: string | null;
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
        throw new Error(`Invalid timezone: ${tz.trim()}`);
      }
      await updateZeroUserPreferences({ timezone: tz.trim() });
      console.log(chalk.green(`Timezone set to ${chalk.cyan(tz.trim())}`));
    }
  }
}

/**
 * zero preference
 *
 * View or update user preferences (timezone).
 */
export const zeroPreferenceCommand = new Command()
  .name("preference")
  .description("View or update user preferences (timezone, notifications)")
  .option("--timezone <timezone>", "IANA timezone (e.g., America/New_York)")
  .action(
    withErrorHandler(async (opts: PreferenceOpts) => {
      const updates = buildUpdates(opts);

      if (updates) {
        const result = await updateZeroUserPreferences(updates);
        printUpdateResult(updates, result);
        return;
      }

      // No flags: display current preferences
      const prefs = await getZeroUserPreferences();
      displayPreferences(prefs);

      if (isInteractive()) {
        await interactiveSetup(prefs);
      } else if (!prefs.timezone) {
        console.log();
        console.log(
          `To set timezone: ${chalk.cyan("zero preference --timezone <timezone>")}`,
        );
        console.log(
          chalk.dim("Example: zero preference --timezone America/New_York"),
        );
      }
    }),
  );
