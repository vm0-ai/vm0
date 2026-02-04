import chalk from "chalk";
import {
  isInteractive as defaultIsInteractive,
  promptText as defaultPromptText,
  promptConfirm as defaultPromptConfirm,
} from "../../lib/utils/prompt-utils";
import type { RequiredConfiguration } from "../../lib/domain/schedule-utils";

/**
 * Result of gathering configuration for schedule setup
 */
interface GatherConfigurationResult {
  /** Vars to send to the server (may be empty) */
  vars: Record<string, string>;
  /** If true, send undefined to server to preserve existing secrets */
  preserveExistingSecrets: boolean;
}

/**
 * Existing schedule information relevant to configuration gathering
 */
interface ExistingScheduleConfig {
  vars?: Record<string, string> | null;
  secretNames?: string[] | null;
}

/**
 * Parameters for gatherConfiguration function
 */
interface GatherConfigurationParams {
  required: RequiredConfiguration;
  optionSecrets: string[]; // Kept for backward compat but ignored
  optionVars: string[];
  existingSchedule: ExistingScheduleConfig | undefined;
}

/**
 * Prompt dependencies for dependency injection (enables testing without mocking internal code)
 */
interface PromptDeps {
  isInteractive: () => boolean;
  promptConfirm: (
    message: string,
    defaultValue?: boolean,
  ) => Promise<boolean | undefined>;
  promptText: (
    message: string,
    defaultValue?: string,
    validate?: (value: string) => boolean | string,
  ) => Promise<string | undefined>;
}

/**
 * Default prompt dependencies using real prompt-utils
 */
const defaultPromptDeps: PromptDeps = {
  isInteractive: defaultIsInteractive,
  promptConfirm: defaultPromptConfirm,
  promptText: defaultPromptText,
};

/**
 * Parse key=value pairs into object
 */
function parseKeyValuePairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex);
      const value = pair.slice(eqIndex + 1);
      result[key] = value;
    }
  }
  return result;
}

/**
 * Handle existing secrets - only preserve, never prompt for new.
 * Secrets are now managed via platform (vm0 secret set).
 */
async function handleExistingSecrets(
  existingSecretNames: string[],
  deps: PromptDeps,
): Promise<boolean> {
  // If updating schedule with existing secrets - ask user if they want to keep them
  if (existingSecretNames.length > 0 && deps.isInteractive()) {
    const keepSecrets = await deps.promptConfirm(
      `Keep existing secrets? (${existingSecretNames.join(", ")})`,
      true,
    );

    if (keepSecrets) {
      return true; // preserveExistingSecrets
    }

    console.log(
      chalk.dim(
        "  Note: Secrets will be cleared. Use 'vm0 secret set' to add platform secrets.",
      ),
    );
    return false;
  }

  return false; // No existing secrets to preserve
}

/**
 * Handle vars from options or existing schedule.
 */
async function handleVars(
  optionVars: string[],
  existingVars: Record<string, string> | null,
  deps: PromptDeps,
): Promise<Record<string, string>> {
  // Explicit --var flags provided
  if (optionVars.length > 0) {
    return parseKeyValuePairs(optionVars);
  }

  // Updating schedule with existing vars - ask user
  if (existingVars && deps.isInteractive()) {
    const keepVars = await deps.promptConfirm(
      `Keep existing variables? (${Object.keys(existingVars).join(", ")})`,
      true,
    );

    if (keepVars) {
      return { ...existingVars };
    }
  }

  return {};
}

/**
 * Display missing configuration requirements
 */
function displayMissingRequirements(
  missingSecrets: string[],
  missingVars: string[],
): void {
  if (missingSecrets.length > 0) {
    console.log(chalk.yellow("\nAgent requires the following secrets:"));
    for (const name of missingSecrets) {
      console.log(chalk.dim(`  ${name}`));
    }
    console.log();
    console.log("Set secrets using the platform:");
    for (const name of missingSecrets) {
      console.log(chalk.cyan(`  vm0 secret set ${name} <value>`));
    }
    console.log();
  }

  if (missingVars.length > 0) {
    console.log(chalk.yellow("\nAgent requires the following variables:"));
    for (const name of missingVars) {
      console.log(chalk.dim(`  ${name}`));
    }
    console.log();
  }
}

/**
 * Prompt for missing vars interactively
 */
async function promptForMissingVars(
  missingVars: string[],
  vars: Record<string, string>,
  deps: PromptDeps,
): Promise<void> {
  for (const name of missingVars) {
    const value = await deps.promptText(
      `Enter value for var ${chalk.cyan(name)}`,
      "",
    );
    if (value) {
      vars[name] = value;
    }
  }
}

/**
 * Gather configuration (vars only) for schedule setup.
 *
 * Secrets are now managed via platform (vm0 secret set), not via schedule CLI.
 * This function still supports preserving existing secrets for backward compat.
 *
 * @param params - Configuration parameters
 * @param deps - Prompt dependencies (optional, for testing)
 */
export async function gatherConfiguration(
  params: GatherConfigurationParams,
  deps: PromptDeps = defaultPromptDeps,
): Promise<GatherConfigurationResult> {
  const { required, optionVars, existingSchedule } = params;

  const existingSecretNames = existingSchedule?.secretNames ?? [];
  const existingVars = existingSchedule?.vars ?? null;

  // Handle existing secrets (preserve or clear, never prompt for new values)
  const preserveExistingSecrets = await handleExistingSecrets(
    existingSecretNames,
    deps,
  );

  // Handle vars from options or existing schedule
  const vars = await handleVars(optionVars, existingVars, deps);

  // Determine which secrets/vars are missing
  const effectiveExistingSecrets = preserveExistingSecrets
    ? existingSecretNames
    : [];
  const missingSecrets = required.secrets.filter(
    (name) => !effectiveExistingSecrets.includes(name),
  );
  const missingVars = required.vars.filter(
    (name) => !Object.keys(vars).includes(name),
  );

  // If nothing is missing or non-interactive, return early
  if (missingSecrets.length === 0 && missingVars.length === 0) {
    return { vars, preserveExistingSecrets };
  }
  if (!deps.isInteractive()) {
    return { vars, preserveExistingSecrets };
  }

  // Interactive mode: show requirements and prompt for missing values
  displayMissingRequirements(missingSecrets, missingVars);
  await promptForMissingVars(missingVars, vars, deps);

  return { vars, preserveExistingSecrets };
}
