import chalk from "chalk";
import {
  isInteractive as defaultIsInteractive,
  promptText as defaultPromptText,
  promptConfirm as defaultPromptConfirm,
  promptPassword as defaultPromptPassword,
} from "../../lib/utils/prompt-utils";
import type { RequiredConfiguration } from "../../lib/domain/schedule-utils";

/**
 * Result of gathering configuration for schedule setup
 */
interface GatherConfigurationResult {
  /** Secrets to send to the server (may be empty) */
  secrets: Record<string, string>;
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
  optionSecrets: string[];
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
  promptPassword: (message: string) => Promise<string | undefined>;
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
  promptPassword: defaultPromptPassword,
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
 * Handle secrets from options or existing schedule.
 * Returns the initial secrets and whether to preserve existing.
 */
async function handleSecrets(
  optionSecrets: string[],
  existingSecretNames: string[],
  deps: PromptDeps,
): Promise<{
  secrets: Record<string, string>;
  preserveExistingSecrets: boolean;
}> {
  // Case 1: Explicit --secret flags provided
  if (optionSecrets.length > 0) {
    return {
      secrets: parseKeyValuePairs(optionSecrets),
      preserveExistingSecrets: false,
    };
  }

  // Case 2: Updating schedule with existing secrets - ask user
  if (existingSecretNames.length > 0 && deps.isInteractive()) {
    const keepSecrets = await deps.promptConfirm(
      `Keep existing secrets? (${existingSecretNames.join(", ")})`,
      true,
    );

    if (keepSecrets) {
      return { secrets: {}, preserveExistingSecrets: true };
    }

    console.log(chalk.dim("  Note: You'll need to provide new secret values"));
    return { secrets: {}, preserveExistingSecrets: false };
  }

  // Case 3: New schedule (no existing secrets)
  return { secrets: {}, preserveExistingSecrets: false };
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
  console.log(chalk.yellow("\nAgent requires the following configuration:"));

  if (missingSecrets.length > 0) {
    console.log(chalk.dim("  Secrets:"));
    for (const name of missingSecrets) {
      console.log(chalk.dim(`    ${name}`));
    }
  }

  if (missingVars.length > 0) {
    console.log(chalk.dim("  Vars:"));
    for (const name of missingVars) {
      console.log(chalk.dim(`    ${name}`));
    }
  }

  console.log("");
}

/**
 * Prompt for missing secrets interactively
 */
async function promptForMissingSecrets(
  missingSecrets: string[],
  secrets: Record<string, string>,
  deps: PromptDeps,
): Promise<void> {
  for (const name of missingSecrets) {
    const value = await deps.promptPassword(
      `Enter value for secret ${chalk.cyan(name)}`,
    );
    if (value) {
      secrets[name] = value;
    }
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
 * Gather all configuration (secrets and vars) for schedule setup.
 *
 * This function handles:
 * 1. --secret and --var flags (non-interactive)
 * 2. Prompting to keep existing secrets/vars (update scenario)
 * 3. Prompting for missing required secrets/vars (interactive)
 *
 * The key insight is that `preserveExistingSecrets` should ONLY be true when:
 * - There ARE existing secrets on the server, AND
 * - The user explicitly chose to keep them
 *
 * For new schedules (no existing secrets), even if no --secret flag is provided,
 * we should gather secrets interactively and send them to the server.
 *
 * @param params - Configuration parameters
 * @param deps - Prompt dependencies (optional, for testing)
 */
export async function gatherConfiguration(
  params: GatherConfigurationParams,
  deps: PromptDeps = defaultPromptDeps,
): Promise<GatherConfigurationResult> {
  const { required, optionSecrets, optionVars, existingSchedule } = params;

  const existingSecretNames = existingSchedule?.secretNames ?? [];
  const existingVars = existingSchedule?.vars ?? null;

  // Handle secrets and vars from options or existing schedule
  const { secrets, preserveExistingSecrets } = await handleSecrets(
    optionSecrets,
    existingSecretNames,
    deps,
  );
  const vars = await handleVars(optionVars, existingVars, deps);

  // Determine which secrets/vars are missing
  const effectiveExistingSecrets = preserveExistingSecrets
    ? existingSecretNames
    : [];
  const missingSecrets = required.secrets.filter(
    (name) =>
      !Object.keys(secrets).includes(name) &&
      !effectiveExistingSecrets.includes(name),
  );
  const missingVars = required.vars.filter(
    (name) => !Object.keys(vars).includes(name),
  );

  // If nothing is missing or non-interactive, return early
  if (missingSecrets.length === 0 && missingVars.length === 0) {
    return { secrets, vars, preserveExistingSecrets };
  }
  if (!deps.isInteractive()) {
    return { secrets, vars, preserveExistingSecrets };
  }

  // Interactive mode: show requirements and prompt for missing values
  displayMissingRequirements(missingSecrets, missingVars);
  await promptForMissingSecrets(missingSecrets, secrets, deps);
  await promptForMissingVars(missingVars, vars, deps);

  return { secrets, vars, preserveExistingSecrets };
}
