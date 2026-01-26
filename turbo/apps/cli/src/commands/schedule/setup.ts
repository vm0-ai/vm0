import { Command } from "commander";
import chalk from "chalk";
import {
  isInteractive,
  promptText,
  promptConfirm,
  promptSelect,
} from "../../lib/utils/prompt-utils";
import {
  generateCronExpression,
  detectTimezone,
  validateTimeFormat,
  validateDateFormat,
  getTomorrowDateLocal,
  getCurrentTimeLocal,
  toISODateTime,
  type ScheduleFrequency,
} from "../../lib/domain/schedule-utils";
import { getComposeByName, deploySchedule, listSchedules } from "../../lib/api";

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

interface SetupOptions {
  frequency?: string;
  time?: string;
  day?: string;
  timezone?: string;
  prompt?: string;
  var?: string[];
  secret?: string[];
  artifactName: string;
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
  .option("--secret <name=value>", "Secret (can be repeated)", collect, [])
  .option("--artifact-name <name>", "Artifact name", "artifact")
  .action(
    // eslint-disable-next-line complexity -- complex interactive flow
    async (agentName: string, options: SetupOptions) => {
      try {
        // 1. Resolve agent to composeId
        const compose = await getComposeByName(agentName);
        if (!compose) {
          console.error(chalk.red(`✗ Agent not found: ${agentName}`));
          console.error(chalk.dim("  Make sure the agent is composed first"));
          process.exit(1);
        }

        const composeId = compose.id;
        const scheduleName = `${agentName}-schedule`;

        // 2. Check for existing schedule
        const { schedules } = await listSchedules();
        const existingSchedule = schedules.find(
          (s) => s.composeName === agentName,
        );

        const isEditMode = !!existingSchedule;
        if (isEditMode) {
          console.log(
            chalk.dim(`Editing existing schedule for agent ${agentName}`),
          );
        } else {
          console.log(
            chalk.dim(`Creating new schedule for agent ${agentName}`),
          );
        }

        // Parse existing schedule for defaults
        let existingFrequency: ScheduleFrequency | undefined;
        let existingDay: number | undefined;
        let existingTime: string | undefined;

        if (existingSchedule?.cronExpression) {
          const parsed = parseFrequencyFromCron(
            existingSchedule.cronExpression,
          );
          if (parsed) {
            existingFrequency = parsed.frequency;
            existingDay = parsed.day;
            existingTime = parsed.time;
          }
        } else if (existingSchedule?.atTime) {
          existingFrequency = "once";
        }

        // 3. Gather frequency
        let frequency: ScheduleFrequency | undefined = options.frequency as
          | ScheduleFrequency
          | undefined;
        if (
          !frequency ||
          !["daily", "weekly", "monthly", "once"].includes(frequency)
        ) {
          if (!isInteractive()) {
            console.error(
              chalk.red(
                "✗ --frequency is required (daily|weekly|monthly|once)",
              ),
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
          if (!frequency) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        // 4. Gather day (for weekly/monthly)
        let day: number | undefined;
        if (frequency === "weekly" || frequency === "monthly") {
          if (options.day) {
            day = parseDayOption(options.day, frequency);
            if (day === undefined) {
              console.error(
                chalk.red(
                  `✗ Invalid day: ${options.day}. Use mon-sun for weekly or 1-31 for monthly.`,
                ),
              );
              process.exit(1);
            }
          } else if (isInteractive()) {
            if (frequency === "weekly") {
              const defaultDayIndex =
                existingDay !== undefined
                  ? DAY_OF_WEEK_CHOICES.findIndex(
                      (c) => c.value === existingDay,
                    )
                  : 0;
              day = await promptSelect(
                "Day of week",
                DAY_OF_WEEK_CHOICES,
                defaultDayIndex >= 0 ? defaultDayIndex : 0,
              );
              if (day === undefined) {
                console.log(chalk.dim("Cancelled"));
                return;
              }
            } else {
              const dayStr = await promptText(
                "Day of month (1-31)",
                existingDay?.toString() || "1",
              );
              if (!dayStr) {
                console.log(chalk.dim("Cancelled"));
                return;
              }
              day = parseInt(dayStr, 10);
              if (isNaN(day) || day < 1 || day > 31) {
                console.error(chalk.red("✗ Day must be between 1 and 31"));
                process.exit(1);
              }
            }
          } else {
            console.error(chalk.red("✗ --day is required for weekly/monthly"));
            process.exit(1);
          }
        }

        // 5. Gather time
        let time: string | undefined = options.time;
        let atTime: string | undefined;

        if (frequency === "once") {
          if (!isInteractive()) {
            console.error(
              chalk.red("✗ One-time schedules require interactive mode"),
            );
            console.error(
              chalk.dim("  Use cron frequency for non-interactive mode"),
            );
            process.exit(1);
          }

          const tomorrowDate = getTomorrowDateLocal();
          const date = await promptText(
            "Date (YYYY-MM-DD, default tomorrow)",
            tomorrowDate,
            validateDateFormat,
          );
          if (!date) {
            console.log(chalk.dim("Cancelled"));
            return;
          }

          const currentTime = getCurrentTimeLocal();
          time = await promptText(
            "Time (HH:MM)",
            existingTime || currentTime,
            validateTimeFormat,
          );
          if (!time) {
            console.log(chalk.dim("Cancelled"));
            return;
          }

          atTime = `${date} ${time}`;
        } else {
          if (!time) {
            if (!isInteractive()) {
              console.error(chalk.red("✗ --time is required (HH:MM format)"));
              process.exit(1);
            }
            time = await promptText(
              "Time (HH:MM)",
              existingTime || "09:00",
              validateTimeFormat,
            );
            if (!time) {
              console.log(chalk.dim("Cancelled"));
              return;
            }
          } else {
            const validation = validateTimeFormat(time);
            if (validation !== true) {
              console.error(chalk.red(`✗ Invalid time: ${validation}`));
              process.exit(1);
            }
          }
        }

        // 6. Gather timezone
        const detectedTimezone = detectTimezone();
        let timezone = options.timezone;
        if (!timezone) {
          if (isInteractive()) {
            timezone = await promptText(
              "Timezone",
              existingSchedule?.timezone || detectedTimezone,
            );
            if (!timezone) {
              console.log(chalk.dim("Cancelled"));
              return;
            }
          } else {
            timezone = detectedTimezone;
          }
        }

        // 7. Gather prompt
        let promptText_ = options.prompt;
        if (!promptText_) {
          if (!isInteractive()) {
            console.error(chalk.red("✗ --prompt is required"));
            process.exit(1);
          }
          promptText_ = await promptText(
            "Prompt to run",
            existingSchedule?.prompt || "let's start working.",
          );
          if (!promptText_) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        // 8. Handle vars
        let vars: Record<string, string> | undefined;
        if (options.var && options.var.length > 0) {
          vars = parseKeyValuePairs(options.var);
        } else if (isInteractive() && existingSchedule?.vars) {
          const keepVars = await promptConfirm(
            `Keep existing variables? (${Object.keys(existingSchedule.vars).join(", ")})`,
            true,
          );
          if (keepVars) {
            vars = existingSchedule.vars;
          }
        }

        // 9. Handle secrets
        let secrets: Record<string, string> | undefined;
        if (options.secret && options.secret.length > 0) {
          secrets = parseKeyValuePairs(options.secret);
        } else if (
          isInteractive() &&
          existingSchedule?.secretNames &&
          existingSchedule.secretNames.length > 0
        ) {
          const keepSecrets = await promptConfirm(
            `Keep existing secrets? (${existingSchedule.secretNames.join(", ")})`,
            true,
          );
          if (!keepSecrets) {
            console.log(
              chalk.dim("  Note: You'll need to provide new secret values"),
            );
          }
          // If keeping secrets, we don't send them (API preserves existing)
          // If not keeping, we need to prompt for new values but can't since
          // this is complex - for now just skip
        }

        // 10. Build trigger
        let cronExpression: string | undefined;
        let atTimeISO: string | undefined;

        if (atTime) {
          atTimeISO = toISODateTime(atTime);
        } else if (time && frequency !== "once") {
          cronExpression = generateCronExpression(frequency, time, day);
        }

        // 11. Expand environment variables
        const expandedVars = expandEnvVarsInObject(vars);
        const expandedSecrets = expandEnvVarsInObject(secrets);

        // 12. Deploy to cloud
        console.log(
          `\nDeploying schedule for agent ${chalk.cyan(agentName)}...`,
        );

        const body = {
          name: scheduleName,
          composeId,
          cronExpression,
          atTime: atTimeISO,
          timezone: timezone || "UTC",
          prompt: promptText_,
          vars: expandedVars,
          secrets: expandedSecrets,
          artifactName: options.artifactName,
        };

        const deployResult = await deploySchedule(body);

        // 13. Display result
        if (deployResult.created) {
          console.log(
            chalk.green(
              `✓ Created schedule for agent ${chalk.cyan(agentName)}`,
            ),
          );
        } else {
          console.log(
            chalk.green(
              `✓ Updated schedule for agent ${chalk.cyan(agentName)}`,
            ),
          );
        }

        console.log(chalk.dim(`  Timezone: ${deployResult.schedule.timezone}`));

        if (deployResult.schedule.cronExpression) {
          console.log(
            chalk.dim(`  Cron: ${deployResult.schedule.cronExpression}`),
          );
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
      } catch (error) {
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
    },
  );
