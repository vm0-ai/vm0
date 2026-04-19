import { Command } from "commander";
import chalk from "chalk";
import {
  isInteractive,
  promptText,
  promptSelect,
  promptConfirm,
} from "../../../lib/utils/prompt-utils";
import {
  generateCronExpression,
  detectTimezone,
  validateTimeFormat,
  validateDateFormat,
  getTomorrowDateLocal,
  getCurrentTimeLocal,
  toISODateTime,
  type ScheduleFrequency,
} from "../../../lib/domain/schedule-utils";
import {
  resolveCompose,
  deployZeroSchedule,
  listZeroSchedules,
  enableZeroSchedule,
  getZeroUserPreferences,
  ApiRequestError,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { parseModelFlag } from "../../../lib/domain/model-provider/shared";

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
  {
    title: "Loop",
    value: "loop" as const,
    description: "Run repeatedly at fixed intervals",
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

  const get = (type: string) => {
    return (
      parts.find((p) => {
        return p.type === type;
      })?.value ?? ""
    );
  };
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

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

interface SetupOptions {
  name?: string;
  frequency?: string;
  time?: string;
  day?: string;
  interval?: string;
  timezone?: string;
  prompt?: string;
  enable?: boolean;
  modelProvider?: string;
  model?: string;
}

interface ExistingScheduleDefaults {
  frequency?: ScheduleFrequency;
  day?: number;
  time?: string;
  intervalSeconds?: number;
}

interface ScheduleListItem {
  name: string;
  agentId: string;
  triggerType?: "cron" | "once" | "loop";
  cronExpression?: string | null;
  atTime?: string | null;
  intervalSeconds?: number | null;
  timezone: string;
  prompt: string;
  enabled?: boolean;
}

function getExistingDefaults(
  existingSchedule: ScheduleListItem | undefined,
): ExistingScheduleDefaults {
  const defaults: ExistingScheduleDefaults = {};

  if (existingSchedule?.triggerType === "loop") {
    defaults.frequency = "loop";
    defaults.intervalSeconds = existingSchedule.intervalSeconds ?? undefined;
  } else if (existingSchedule?.cronExpression) {
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

async function gatherFrequency(
  optionFrequency: string | undefined,
  existingFrequency: ScheduleFrequency | undefined,
): Promise<ScheduleFrequency | null> {
  let frequency = optionFrequency as ScheduleFrequency | undefined;

  if (
    frequency &&
    ["daily", "weekly", "monthly", "once", "loop"].includes(frequency)
  ) {
    return frequency;
  }

  if (!isInteractive()) {
    throw new Error("--frequency is required (daily|weekly|monthly|once|loop)");
  }

  const defaultIndex = existingFrequency
    ? FREQUENCY_CHOICES.findIndex((c) => {
        return c.value === existingFrequency;
      })
    : 0;

  frequency = await promptSelect<ScheduleFrequency>(
    "Schedule frequency",
    FREQUENCY_CHOICES,
    defaultIndex >= 0 ? defaultIndex : 0,
  );

  return frequency || null;
}

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
      throw new Error(
        `Invalid day: ${optionDay}. Use mon-sun for weekly or 1-31 for monthly.`,
      );
    }
    return day;
  }

  if (!isInteractive()) {
    throw new Error("--day is required for weekly/monthly");
  }

  if (frequency === "weekly") {
    const defaultDayIndex =
      existingDay !== undefined
        ? DAY_OF_WEEK_CHOICES.findIndex((c) => {
            return c.value === existingDay;
          })
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
    throw new Error("Day must be between 1 and 31");
  }
  return day;
}

async function gatherRecurringTime(
  optionTime: string | undefined,
  existingTime: string | undefined,
): Promise<string | undefined> {
  if (optionTime) {
    const validation = validateTimeFormat(optionTime);
    if (validation !== true) {
      throw new Error(`Invalid time: ${validation}`);
    }
    return optionTime;
  }

  if (!isInteractive()) {
    throw new Error("--time is required (HH:MM format)");
  }

  return await promptText(
    "Time (HH:MM)",
    existingTime || "09:00",
    validateTimeFormat,
  );
}

async function gatherOneTimeSchedule(
  optionDay: string | undefined,
  optionTime: string | undefined,
  existingTime: string | undefined,
): Promise<string | null> {
  if (optionDay && optionTime) {
    if (!validateDateFormat(optionDay)) {
      throw new Error(
        `Invalid date format: ${optionDay}. Use YYYY-MM-DD format.`,
      );
    }
    if (!validateTimeFormat(optionTime)) {
      throw new Error(`Invalid time format: ${optionTime}. Use HH:MM format.`);
    }
    return `${optionDay} ${optionTime}`;
  }

  if (!isInteractive()) {
    throw new Error("One-time schedules require interactive mode", {
      cause: new Error(
        "Or provide --day (YYYY-MM-DD) and --time (HH:MM) flags",
      ),
    });
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

async function gatherTimezone(
  optionTimezone: string | undefined,
  existingTimezone: string | undefined | null,
): Promise<string | undefined> {
  if (optionTimezone) return optionTimezone;

  let userTimezone: string | null = null;
  try {
    const prefs = await getZeroUserPreferences();
    userTimezone = prefs.timezone;
  } catch {
    console.log(
      chalk.dim("Could not fetch timezone preference, using detected timezone"),
    );
  }

  const defaultTimezone = userTimezone || detectTimezone();

  if (!isInteractive()) {
    return defaultTimezone;
  }

  return await promptText("Timezone", existingTimezone || defaultTimezone);
}

async function gatherPromptText(
  optionPrompt: string | undefined,
  existingPrompt: string | undefined | null,
): Promise<string | undefined> {
  if (optionPrompt) return optionPrompt;

  if (!isInteractive()) {
    throw new Error("--prompt is required");
  }

  return await promptText(
    "Prompt to run",
    existingPrompt || "let's start working.",
  );
}

async function gatherInterval(
  optionInterval: string | undefined,
  existingInterval: number | undefined,
): Promise<number | null> {
  if (optionInterval) {
    const val = parseInt(optionInterval, 10);
    if (isNaN(val) || val < 0) {
      throw new Error(
        "Invalid interval. Must be a non-negative integer (seconds)",
      );
    }
    return val;
  }

  if (!isInteractive()) {
    throw new Error("--interval is required for loop schedules (seconds)");
  }

  const defaultVal =
    existingInterval !== undefined ? String(existingInterval) : "300";
  const result = await promptText(
    "Interval in seconds (time between runs)",
    defaultVal,
    (v: string) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0) return "Must be a non-negative integer";
      return true;
    },
  );
  if (!result) return null;
  return parseInt(result, 10);
}

async function gatherTiming(
  frequency: ScheduleFrequency,
  options: SetupOptions,
  defaults: ExistingScheduleDefaults,
): Promise<{
  day: number | undefined;
  time: string | undefined;
  atTime: string | undefined;
  intervalSeconds: number | undefined;
} | null> {
  if (frequency === "loop") {
    const intervalSeconds = await gatherInterval(
      options.interval,
      defaults.intervalSeconds,
    );
    if (intervalSeconds === null) return null;
    return {
      day: undefined,
      time: undefined,
      atTime: undefined,
      intervalSeconds,
    };
  }

  if (frequency === "once") {
    const result = await gatherOneTimeSchedule(
      options.day,
      options.time,
      defaults.time,
    );
    if (!result) return null;
    return {
      day: undefined,
      time: undefined,
      atTime: result,
      intervalSeconds: undefined,
    };
  }

  const day =
    (await gatherDay(frequency, options.day, defaults.day)) ?? undefined;
  if (day === null && (frequency === "weekly" || frequency === "monthly")) {
    return null;
  }

  const time = await gatherRecurringTime(options.time, defaults.time);
  if (!time) return null;

  return { day, time, atTime: undefined, intervalSeconds: undefined };
}

async function findExistingSchedule(
  agentId: string,
  scheduleName: string,
): Promise<ScheduleListItem | undefined> {
  const { schedules } = await listZeroSchedules();
  return schedules.find((s) => {
    return s.agentId === agentId && s.name === scheduleName;
  });
}

interface DeployResult {
  created: boolean;
  schedule: {
    triggerType?: "cron" | "once" | "loop";
    timezone: string;
    cronExpression?: string | null;
    nextRunAt?: string | null;
    atTime?: string | null;
    intervalSeconds?: number | null;
  };
}

async function buildAndDeploy(params: {
  scheduleName: string;
  agentId: string;
  agentName: string;
  frequency: ScheduleFrequency;
  time: string | undefined;
  day: number | undefined;
  atTime: string | undefined;
  intervalSeconds: number | undefined;
  timezone: string;
  prompt: string;
  existingEnabled: boolean | undefined;
  modelProviderId: string | null | undefined;
  selectedModel: string | null | undefined;
}): Promise<DeployResult> {
  let cronExpression: string | undefined;
  let atTimeISO: string | undefined;

  if (params.frequency === "loop") {
    // Loop mode: intervalSeconds is passed directly
  } else if (params.atTime) {
    atTimeISO = toISODateTime(params.atTime);
  } else if (params.time && params.frequency !== "once") {
    cronExpression = generateCronExpression(
      params.frequency,
      params.time,
      params.day,
    );
  }

  console.log(
    `\nDeploying schedule for agent ${chalk.cyan(params.agentName)}...`,
  );

  // Preserve enabled state on update so loop schedules don't lose nextRunAt.
  // On create, existingEnabled is undefined → omit the field so the server
  // applies its default (disabled; enable happens later via the enable flow).
  const deployResult = await deployZeroSchedule({
    name: params.scheduleName,
    agentId: params.agentId,
    cronExpression,
    atTime: atTimeISO,
    intervalSeconds: params.intervalSeconds,
    timezone: params.timezone,
    prompt: params.prompt,
    ...(params.existingEnabled !== undefined && {
      enabled: params.existingEnabled,
    }),
    ...(params.modelProviderId !== undefined && {
      modelProviderId: params.modelProviderId,
    }),
    ...(params.selectedModel !== undefined && {
      selectedModel: params.selectedModel,
    }),
  });

  return deployResult;
}

function displayDeployResult(
  scheduleName: string,
  deployResult: DeployResult,
): void {
  if (deployResult.created) {
    console.log(chalk.green(`✓ Schedule "${scheduleName}" created`));
  } else {
    console.log(chalk.green(`✓ Schedule "${scheduleName}" updated`));
  }

  console.log(chalk.dim(`  Timezone: ${deployResult.schedule.timezone}`));

  if (
    deployResult.schedule.triggerType === "loop" &&
    deployResult.schedule.intervalSeconds != null
  ) {
    console.log(
      chalk.dim(
        `  Mode: Loop (interval ${deployResult.schedule.intervalSeconds}s)`,
      ),
    );
  } else if (deployResult.schedule.cronExpression) {
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

async function tryEnableSchedule(
  scheduleName: string,
  agentId: string,
  agentName: string,
): Promise<void> {
  try {
    await enableZeroSchedule({ name: scheduleName, agentId });
    console.log(chalk.green(`✓ Schedule "${scheduleName}" enabled`));
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
      `  To enable manually: ${chalk.cyan(`zero schedule enable ${agentName}`)}`,
    );
  }
}

function showEnableHint(agentName: string): void {
  console.log();
  console.log(
    `  To enable: ${chalk.cyan(`zero schedule enable ${agentName}`)}`,
  );
}

async function handleScheduleEnabling(params: {
  scheduleName: string;
  agentId: string;
  agentName: string;
  enableFlag: boolean;
  shouldPromptEnable: boolean;
}): Promise<void> {
  const { scheduleName, agentId, agentName, enableFlag, shouldPromptEnable } =
    params;

  if (enableFlag) {
    await tryEnableSchedule(scheduleName, agentId, agentName);
    return;
  }

  if (shouldPromptEnable && isInteractive()) {
    const enableNow = await promptConfirm("Enable this schedule?", true);
    if (enableNow) {
      await tryEnableSchedule(scheduleName, agentId, agentName);
    } else {
      showEnableHint(agentName);
    }
    return;
  }

  if (shouldPromptEnable) {
    showEnableHint(agentName);
  }
}

export const setupCommand = new Command()
  .name("setup")
  .description("Create or edit a schedule for a zero agent")
  .argument("<agent-id>", "Agent ID")
  .option("-n, --name <schedule-name>", 'Schedule name (default: "default")')
  .option("-f, --frequency <type>", "Frequency: daily|weekly|monthly|once|loop")
  .option("-t, --time <HH:MM>", "Time to run (24-hour format)")
  .option("-d, --day <day>", "Day of week (mon-sun) or day of month (1-31)")
  .option("-i, --interval <seconds>", "Interval in seconds for loop mode")
  .option("-z, --timezone <tz>", "IANA timezone")
  .option("-p, --prompt <text>", "Prompt to run")
  .option("-e, --enable", "Enable schedule immediately after creation")
  .option(
    "--model-provider <id>",
    "Model provider UUID, or 'default' to inherit from agent/org",
  )
  .option(
    "--model <name>",
    "Model name (e.g. claude-sonnet-4-6, MiniMax-M2.7), or 'default' to inherit",
  )
  .addHelpText(
    "after",
    `
Examples:
  Daily at 9am:          zero schedule setup <agent-id> -f daily -t 09:00 -p "run report"
  Weekly on Monday:      zero schedule setup <agent-id> -f weekly -d mon -t 10:00 -p "weekly sync"
  Monthly on the 1st:    zero schedule setup <agent-id> -f monthly -d 1 -t 08:00 -p "monthly review"
  One-time:              zero schedule setup <agent-id> -f once -d 2026-04-01 -t 14:00 -p "one-off task"
  Loop every 5 minutes:  zero schedule setup <agent-id> -f loop -i 300 -p "poll for updates"
  Create and enable:     zero schedule setup <agent-id> -f daily -t 09:00 -p "run report" --enable
  Override model:        zero schedule setup <agent-id> -f daily -t 09:00 -p "..." --model-provider <id> --model MiniMax-M2.7
  Reset model override:  zero schedule setup <agent-id> -f daily -t 09:00 -p "..." --model-provider default --model default

Notes:
  - Re-running setup with the same agent updates the existing "default" schedule
  - Use -n to manage multiple named schedules for the same agent
  - --model-provider and --model default to inheriting the agent's configuration
  - Use 'zero org model-provider list' to see available providers and models
  - All flags are required in non-interactive mode; interactive mode prompts for missing values
  - If the user wants to be notified when a schedule completes, ask them where they want to receive the notification: web chat or Slack, then include it in the prompt`,
  )
  .action(
    withErrorHandler(async (agentIdentifier: string, options: SetupOptions) => {
      // 1. Resolve agent identifier (UUID or name) to compose ID
      const compose = await resolveCompose(agentIdentifier);
      if (!compose) {
        throw new Error(`Agent not found: ${agentIdentifier}`);
      }
      const agentId = compose.id;
      const scheduleName = options.name || "default";

      // 2. Check for existing schedule
      const existingSchedule = await findExistingSchedule(
        agentId,
        scheduleName,
      );

      const agentName = compose.name;
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
      const { day, time, atTime, intervalSeconds } = timing;

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

      // 7. Build trigger and deploy
      const deployResult = await buildAndDeploy({
        scheduleName,
        agentId,
        agentName,
        frequency,
        time,
        day,
        atTime,
        intervalSeconds,
        timezone,
        prompt: promptText_,
        existingEnabled: existingSchedule?.enabled,
        modelProviderId: parseModelFlag(options.modelProvider),
        selectedModel: parseModelFlag(options.model),
      });

      // 8. Display deployment result
      displayDeployResult(scheduleName, deployResult);

      // 9. Handle schedule enabling
      const shouldPromptEnable =
        deployResult.created ||
        (existingSchedule !== undefined && !existingSchedule.enabled);

      await handleScheduleEnabling({
        scheduleName,
        agentId,
        agentName,
        enableFlag: options.enable ?? false,
        shouldPromptEnable,
      });
    }),
  );
