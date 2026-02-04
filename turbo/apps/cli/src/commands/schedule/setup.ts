import { Command } from "commander";
import chalk from "chalk";
import {
  isInteractive,
  promptText,
  promptSelect,
  promptConfirm,
} from "../../lib/utils/prompt-utils";
import {
  generateCronExpression,
  detectTimezone,
  validateTimeFormat,
  validateDateFormat,
  getTomorrowDateLocal,
  getCurrentTimeLocal,
  toISODateTime,
  extractRequiredConfiguration,
  type ScheduleFrequency,
} from "../../lib/domain/schedule-utils";
import {
  getComposeByName,
  deploySchedule,
  listSchedules,
  enableSchedule,
  ApiRequestError,
} from "../../lib/api";
import { gatherConfiguration } from "./gather-configuration";

const FREQUENCY_CHOICES = [
  { title: "Daily", value: "daily" as const, description: "Run every day" },
  {
    title: "Weekly",
    value: "weekly" as const,
    description: "Run once per week",
  },
  {
    title: "Monthly",
    value: "monthly" as const,
    description: "Run once per month",
  },
  {
    title: "One-time",
    value: "once" as const,
    description: "Run once at specific time",
  },
];

const DAY_OF_WEEK_CHOICES = [
  { title: "Monday", value: 1 },
  { title: "Tuesday", value: 2 },
  { title: "Wednesday", value: 3 },
  { title: "Thursday", value: 4 },
  { title: "Friday", value: 5 },
  { title: "Saturday", value: 6 },
  { title: "Sunday", value: 0 },
];

/**
 * Parse day option for weekly (mon-sun) or monthly (1-31)
 */
function parseDayOption(
  day: string,
  frequency: ScheduleFrequency,
): number | undefined {
  if (frequency === "weekly") {
    const dayMap: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };
    return dayMap[day.toLowerCase()];
  } else if (frequency === "monthly") {
    const num = parseInt(day, 10);
    if (num >= 1 && num <= 31) {
      return num;
    }
  }
  return undefined;
}

/**
 * Expand environment variables in a string
 * Supports ${VAR} syntax
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.warn(
        chalk.yellow(`  Warning: Environment variable ${varName} not set`),
      );
      return match;
    }
    return envValue;
  });
}

/**
 * Expand env vars in an object
 */
function expandEnvVarsInObject(
  obj: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!obj) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = expandEnvVars(value);
  }
  return result;
}

/**
 * Format an ISO date string in a specific timezone as YYYY-MM-DD HH:MM
 */
function formatInTimezone(isoDate: string, timezone: string): string {
  const date = new Date(isoDate);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * Parse frequency from cron expression
 */
function parseFrequencyFromCron(
  cron: string,
): { frequency: ScheduleFrequency; day?: number; time: string } | null {
  const parts = cron.split(" ");
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;
  const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return { frequency: "daily", time };
  } else if (dayOfMonth === "*" && dayOfWeek !== "*") {
    return { frequency: "weekly", day: parseInt(dayOfWeek!, 10), time };
  } else if (dayOfMonth !== "*" && dayOfWeek === "*") {
    return { frequency: "monthly", day: parseInt(dayOfMonth!, 10), time };
  }

  return null;
}

/**
 * Collect function for repeatable options
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

interface SetupOptions {
  frequency?: string;
  time?: string;
  day?: string;
  timezone?: string;
  prompt?: string;
  var?: string[];
  artifactName: string;
  enable?: boolean;
}

interface ExistingScheduleDefaults {
  frequency?: ScheduleFrequency;
  day?: number;
  time?: string;
}

interface ScheduleListItem {
  composeName: string;
  cronExpression?: string | null;
  atTime?: string | null;
  timezone: string;
  prompt: string;
  vars?: Record<string, string> | null;
  secretNames?: string[] | null;
  enabled?: boolean;
}

/**
 * Get defaults from existing schedule
 */
function getExistingDefaults(
  existingSchedule: ScheduleListItem | undefined,
): ExistingScheduleDefaults {
  const defaults: ExistingScheduleDefaults = {};

  if (existingSchedule?.cronExpression) {
    const parsed = parseFrequencyFromCron(existingSchedule.cronExpression);
    if (parsed) {
      defaults.frequency = parsed.frequency;
      defaults.day = parsed.day;
      defaults.time = parsed.time;
    }
  } else if (existingSchedule?.atTime) {
    defaults.frequency = "once";
  }

  return defaults;
}

/**
 * Gather frequency from options or interactive prompt
 */
async function gatherFrequency(
  optionFrequency: string | undefined,
  existingFrequency: ScheduleFrequency | undefined,
): Promise<ScheduleFrequency | null> {
  let frequency = optionFrequency as ScheduleFrequency | undefined;

  if (frequency && ["daily", "weekly", "monthly", "once"].includes(frequency)) {
    return frequency;
  }

  if (!isInteractive()) {
    console.error(
      chalk.red("✗ --frequency is required (daily|weekly|monthly|once)"),
    );
    process.exit(1);
  }

  const defaultIndex = existingFrequency
    ? FREQUENCY_CHOICES.findIndex((c) => c.value === existingFrequency)
    : 0;

  frequency = await promptSelect<ScheduleFrequency>(
    "Schedule frequency",
    FREQUENCY_CHOICES,
    defaultIndex >= 0 ? defaultIndex : 0,
  );

  return frequency || null;
}

/**
 * Gather day for weekly/monthly frequency
 */
async function gatherDay(
  frequency: ScheduleFrequency,
  optionDay: string | undefined,
  existingDay: number | undefined,
): Promise<number | null> {
  if (frequency !== "weekly" && frequency !== "monthly") {
    return null;
  }

  if (optionDay) {
    const day = parseDayOption(optionDay, frequency);
    if (day === undefined) {
      console.error(
        chalk.red(
          `✗ Invalid day: ${optionDay}. Use mon-sun for weekly or 1-31 for monthly.`,
        ),
      );
      process.exit(1);
    }
    return day;
  }

  if (!isInteractive()) {
    console.error(chalk.red("✗ --day is required for weekly/monthly"));
    process.exit(1);
  }

  if (frequency === "weekly") {
    const defaultDayIndex =
      existingDay !== undefined
        ? DAY_OF_WEEK_CHOICES.findIndex((c) => c.value === existingDay)
        : 0;
    const day = await promptSelect(
      "Day of week",
      DAY_OF_WEEK_CHOICES,
      defaultDayIndex >= 0 ? defaultDayIndex : 0,
    );
    return day ?? null;
  }

  const dayStr = await promptText(
    "Day of month (1-31)",
    existingDay?.toString() || "1",
  );
  if (!dayStr) return null;

  const day = parseInt(dayStr, 10);
  if (isNaN(day) || day < 1 || day > 31) {
    console.error(chalk.red("✗ Day must be between 1 and 31"));
    process.exit(1);
  }
  return day;
}

/**
 * Gather time for recurring schedules
 */
async function gatherRecurringTime(
  optionTime: string | undefined,
  existingTime: string | undefined,
): Promise<string | undefined> {
  if (optionTime) {
    const validation = validateTimeFormat(optionTime);
    if (validation !== true) {
      console.error(chalk.red(`✗ Invalid time: ${validation}`));
      process.exit(1);
    }
    return optionTime;
  }

  if (!isInteractive()) {
    console.error(chalk.red("✗ --time is required (HH:MM format)"));
    process.exit(1);
  }

  return await promptText(
    "Time (HH:MM)",
    existingTime || "09:00",
    validateTimeFormat,
  );
}

/**
 * Gather date and time for one-time schedule
 */
async function gatherOneTimeSchedule(
  optionDay: string | undefined,
  optionTime: string | undefined,
  existingTime: string | undefined,
): Promise<string | null> {
  if (optionDay && optionTime) {
    if (!validateDateFormat(optionDay)) {
      console.error(
        chalk.red(
          `✗ Invalid date format: ${optionDay}. Use YYYY-MM-DD format.`,
        ),
      );
      process.exit(1);
    }
    if (!validateTimeFormat(optionTime)) {
      console.error(
        chalk.red(`✗ Invalid time format: ${optionTime}. Use HH:MM format.`),
      );
      process.exit(1);
    }
    return `${optionDay} ${optionTime}`;
  }

  if (!isInteractive()) {
    console.error(chalk.red("✗ One-time schedules require interactive mode"));
    console.error(
      chalk.dim("  Or provide --day (YYYY-MM-DD) and --time (HH:MM) flags"),
    );
    process.exit(1);
  }

  const tomorrowDate = getTomorrowDateLocal();
  const date = await promptText(
    "Date (YYYY-MM-DD, default tomorrow)",
    tomorrowDate,
    validateDateFormat,
  );
  if (!date) return null;

  const currentTime = getCurrentTimeLocal();
  const time = await promptText(
    "Time (HH:MM)",
    existingTime || currentTime,
    validateTimeFormat,
  );
  if (!time) return null;

  return `${date} ${time}`;
}

/**
 * Gather timezone from options or interactive prompt
 */
async function gatherTimezone(
  optionTimezone: string | undefined,
  existingTimezone: string | undefined | null,
): Promise<string | undefined> {
  if (optionTimezone) return optionTimezone;

  const detectedTimezone = detectTimezone();

  if (!isInteractive()) {
    return detectedTimezone;
  }

  return await promptText("Timezone", existingTimezone || detectedTimezone);
}

/**
 * Gather prompt text from options or interactive prompt
 */
async function gatherPromptText(
  optionPrompt: string | undefined,
  existingPrompt: string | undefined | null,
): Promise<string | undefined> {
  if (optionPrompt) return optionPrompt;

  if (!isInteractive()) {
    console.error(chalk.red("✗ --prompt is required"));
    process.exit(1);
  }

  return await promptText(
    "Prompt to run",
    existingPrompt || "let's start working.",
  );
}

/**
 * Resolve agent and get composeId with content
 */
async function resolveAgent(agentName: string): Promise<{
  composeId: string;
  scheduleName: string;
  composeContent: unknown;
}> {
  const compose = await getComposeByName(agentName);
  if (!compose) {
    console.error(chalk.red(`✗ Agent not found: ${agentName}`));
    console.error(chalk.dim("  Make sure the agent is composed first"));
    process.exit(1);
  }
  return {
    composeId: compose.id,
    scheduleName: `${agentName}-schedule`,
    composeContent: compose.content,
  };
}

/**
 * Gather timing configuration (day, time, atTime) based on frequency
 */
async function gatherTiming(
  frequency: ScheduleFrequency,
  options: SetupOptions,
  defaults: ExistingScheduleDefaults,
): Promise<{
  day: number | undefined;
  time: string | undefined;
  atTime: string | undefined;
} | null> {
  if (frequency === "once") {
    const result = await gatherOneTimeSchedule(
      options.day,
      options.time,
      defaults.time,
    );
    if (!result) return null;
    return { day: undefined, time: undefined, atTime: result };
  }

  const day =
    (await gatherDay(frequency, options.day, defaults.day)) ?? undefined;
  if (day === null && (frequency === "weekly" || frequency === "monthly")) {
    return null;
  }

  const time = await gatherRecurringTime(options.time, defaults.time);
  if (!time) return null;

  return { day, time, atTime: undefined };
}

/**
 * Find existing schedule for agent
 */
async function findExistingSchedule(
  agentName: string,
): Promise<ScheduleListItem | undefined> {
  const { schedules } = await listSchedules();
  return schedules.find((s) => s.composeName === agentName);
}

interface DeployResult {
  created: boolean;
  schedule: {
    timezone: string;
    cronExpression?: string | null;
    nextRunAt?: string | null;
    atTime?: string | null;
  };
}

/**
 * Build and deploy schedule
 */
async function buildAndDeploy(params: {
  scheduleName: string;
  composeId: string;
  agentName: string;
  frequency: ScheduleFrequency;
  time: string | undefined;
  day: number | undefined;
  atTime: string | undefined;
  timezone: string;
  prompt: string;
  vars: Record<string, string> | undefined;
  secrets: Record<string, string> | undefined;
  artifactName: string;
}): Promise<DeployResult> {
  let cronExpression: string | undefined;
  let atTimeISO: string | undefined;

  if (params.atTime) {
    atTimeISO = toISODateTime(params.atTime);
  } else if (params.time && params.frequency !== "once") {
    cronExpression = generateCronExpression(
      params.frequency,
      params.time,
      params.day,
    );
  }

  const expandedVars = expandEnvVarsInObject(params.vars);
  const expandedSecrets = expandEnvVarsInObject(params.secrets);

  console.log(
    `\nDeploying schedule for agent ${chalk.cyan(params.agentName)}...`,
  );

  const deployResult = await deploySchedule({
    name: params.scheduleName,
    composeId: params.composeId,
    cronExpression,
    atTime: atTimeISO,
    timezone: params.timezone,
    prompt: params.prompt,
    vars: expandedVars,
    secrets: expandedSecrets,
    artifactName: params.artifactName,
  });

  return deployResult;
}

/**
 * Handle setup command errors
 */
function handleSetupError(error: unknown): never {
  console.error(chalk.red("✗ Failed to setup schedule"));
  if (error instanceof Error) {
    if (error.message.includes("Not authenticated")) {
      console.error(chalk.dim("  Run: vm0 auth login"));
    } else {
      console.error(chalk.dim(`  ${error.message}`));
    }
  }
  process.exit(1);
}

/**
 * Display deployment result
 */
function displayDeployResult(
  agentName: string,
  deployResult: DeployResult,
): void {
  if (deployResult.created) {
    console.log(
      chalk.green(`✓ Created schedule for agent ${chalk.cyan(agentName)}`),
    );
  } else {
    console.log(
      chalk.green(`✓ Updated schedule for agent ${chalk.cyan(agentName)}`),
    );
  }

  console.log(chalk.dim(`  Timezone: ${deployResult.schedule.timezone}`));

  if (deployResult.schedule.cronExpression) {
    console.log(chalk.dim(`  Cron: ${deployResult.schedule.cronExpression}`));
    if (deployResult.schedule.nextRunAt) {
      const nextRun = formatInTimezone(
        deployResult.schedule.nextRunAt,
        deployResult.schedule.timezone,
      );
      console.log(chalk.dim(`  Next run: ${nextRun}`));
    }
  } else if (deployResult.schedule.atTime) {
    const atTimeFormatted = formatInTimezone(
      deployResult.schedule.atTime,
      deployResult.schedule.timezone,
    );
    console.log(chalk.dim(`  At: ${atTimeFormatted}`));
  }
}

/**
 * Try to enable a schedule, handling errors gracefully
 */
async function tryEnableSchedule(
  scheduleName: string,
  composeId: string,
  agentName: string,
): Promise<void> {
  try {
    await enableSchedule({ name: scheduleName, composeId });
    console.log(
      chalk.green(`✓ Enabled schedule for agent ${chalk.cyan(agentName)}`),
    );
  } catch (error) {
    console.error(chalk.yellow("⚠ Failed to enable schedule"));
    if (error instanceof ApiRequestError) {
      if (error.code === "SCHEDULE_PAST") {
        console.error(chalk.dim("  Scheduled time has already passed"));
      } else {
        console.error(chalk.dim(`  ${error.message}`));
      }
    } else if (error instanceof Error) {
      console.error(chalk.dim(`  ${error.message}`));
    }
    console.log(
      `  To enable manually: ${chalk.cyan(`vm0 schedule enable ${agentName}`)}`,
    );
  }
}

/**
 * Show hint for manual enable command
 */
function showEnableHint(agentName: string): void {
  console.log();
  console.log(`  To enable: ${chalk.cyan(`vm0 schedule enable ${agentName}`)}`);
}

/**
 * Handle schedule enabling after deployment
 */
async function handleScheduleEnabling(params: {
  scheduleName: string;
  composeId: string;
  agentName: string;
  enableFlag: boolean;
  shouldPromptEnable: boolean;
}): Promise<void> {
  const { scheduleName, composeId, agentName, enableFlag, shouldPromptEnable } =
    params;

  if (enableFlag) {
    // --enable flag: auto-enable
    await tryEnableSchedule(scheduleName, composeId, agentName);
    return;
  }

  if (shouldPromptEnable && isInteractive()) {
    // Interactive: prompt user (default: yes)
    const enableNow = await promptConfirm("Enable this schedule?", true);
    if (enableNow) {
      await tryEnableSchedule(scheduleName, composeId, agentName);
    } else {
      showEnableHint(agentName);
    }
    return;
  }

  if (shouldPromptEnable) {
    // Non-interactive without --enable: show hint
    showEnableHint(agentName);
  }
}

export const setupCommand = new Command()
  .name("setup")
  .description("Create or edit a schedule for an agent")
  .argument("<agent-name>", "Agent name to configure schedule for")
  .option("-f, --frequency <type>", "Frequency: daily|weekly|monthly|once")
  .option("-t, --time <HH:MM>", "Time to run (24-hour format)")
  .option("-d, --day <day>", "Day of week (mon-sun) or day of month (1-31)")
  .option("-z, --timezone <tz>", "IANA timezone")
  .option("-p, --prompt <text>", "Prompt to run")
  .option("--var <name=value>", "Variable (can be repeated)", collect, [])
  .option("--artifact-name <name>", "Artifact name", "artifact")
  .option("-e, --enable", "Enable schedule immediately after creation")
  .action(async (agentName: string, options: SetupOptions) => {
    try {
      // 1. Resolve agent to composeId and get content
      const { composeId, scheduleName, composeContent } =
        await resolveAgent(agentName);

      // Extract required configuration from compose
      const requiredConfig = extractRequiredConfiguration(composeContent);

      // 2. Check for existing schedule
      const existingSchedule = await findExistingSchedule(agentName);

      console.log(
        chalk.dim(
          existingSchedule
            ? `Editing existing schedule for agent ${agentName}`
            : `Creating new schedule for agent ${agentName}`,
        ),
      );

      const defaults = getExistingDefaults(existingSchedule);

      // 3. Gather frequency
      const frequency = await gatherFrequency(
        options.frequency,
        defaults.frequency,
      );
      if (!frequency) {
        console.log(chalk.dim("Cancelled"));
        return;
      }

      // 4. Gather day and time
      const timing = await gatherTiming(frequency, options, defaults);
      if (!timing) {
        console.log(chalk.dim("Cancelled"));
        return;
      }
      const { day, time, atTime } = timing;

      // 5. Gather timezone
      const timezone = await gatherTimezone(
        options.timezone,
        existingSchedule?.timezone,
      );
      if (!timezone) {
        console.log(chalk.dim("Cancelled"));
        return;
      }

      // 6. Gather prompt
      const promptText_ = await gatherPromptText(
        options.prompt,
        existingSchedule?.prompt,
      );
      if (!promptText_) {
        console.log(chalk.dim("Cancelled"));
        return;
      }

      // 7. Gather vars configuration (secrets are now managed via platform)
      const config = await gatherConfiguration({
        required: requiredConfig,
        optionSecrets: [], // Secrets are no longer passed via CLI
        optionVars: options.var || [],
        existingSchedule,
      });

      // 8. Build trigger and deploy
      // Secrets are managed via platform (vm0 secret set), not via schedule
      // If preserveExistingSecrets is true, we pass undefined to keep existing secrets
      // Otherwise we also pass undefined (no new secrets can be added via CLI)
      const deployResult = await buildAndDeploy({
        scheduleName,
        composeId,
        agentName,
        frequency,
        time,
        day,
        atTime,
        timezone,
        prompt: promptText_,
        vars: Object.keys(config.vars).length > 0 ? config.vars : undefined,
        secrets: undefined, // Secrets managed via platform, not schedule
        artifactName: options.artifactName,
      });

      // 9. Display deployment result
      displayDeployResult(agentName, deployResult);

      // 10. Handle schedule enabling
      // Prompt if: new schedule OR updating a disabled schedule
      const shouldPromptEnable =
        deployResult.created ||
        (existingSchedule !== undefined && !existingSchedule.enabled);

      await handleScheduleEnabling({
        scheduleName,
        composeId,
        agentName,
        enableFlag: options.enable ?? false,
        shouldPromptEnable,
      });
    } catch (error) {
      handleSetupError(error);
    }
  });
