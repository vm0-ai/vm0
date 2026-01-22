import { Command } from "commander";
import chalk from "chalk";
import { existsSync, writeFileSync } from "fs";
import { stringify as stringifyYaml } from "yaml";
import {
  isInteractive,
  promptText,
  promptConfirm,
  promptSelect,
} from "../../lib/utils/prompt-utils";
import {
  loadAgentName,
  generateCronExpression,
  detectTimezone,
  extractVarsAndSecrets,
  validateTimeFormat,
  validateDateFormat,
  getTomorrowDateLocal,
  getCurrentTimeLocal,
  type ScheduleFrequency,
} from "../../lib/domain/schedule-utils";

const SCHEDULE_FILE = "schedule.yaml";

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

export const initCommand = new Command()
  .name("init")
  .description("Create a schedule.yaml interactively")
  .option("-n, --name <name>", "Schedule name")
  .option("-f, --frequency <type>", "Frequency: daily|weekly|monthly|once")
  .option("-t, --time <HH:MM>", "Time to run (24-hour format)")
  .option("-d, --day <day>", "Day of week (mon-sun) or day of month (1-31)")
  .option("-z, --timezone <tz>", "IANA timezone")
  .option("-p, --prompt <text>", "Prompt to run")
  .option("--no-vars", "Don't include vars from vm0.yaml")
  .option("--force", "Overwrite existing schedule.yaml")
  .action(
    // eslint-disable-next-line complexity -- TODO: refactor complex function
    async (options: {
      name?: string;
      frequency?: string;
      time?: string;
      day?: string;
      timezone?: string;
      prompt?: string;
      vars: boolean;
      force?: boolean;
    }) => {
      try {
        // 1. Check vm0.yaml exists
        const { agentName, error } = loadAgentName();
        if (error) {
          console.error(chalk.red(`✗ Invalid vm0.yaml: ${error}`));
          process.exit(1);
        }
        if (!agentName) {
          console.error(chalk.red("✗ No vm0.yaml found"));
          console.error(
            chalk.dim("  Run this command from an agent directory"),
          );
          process.exit(1);
        }

        // 2. Check if schedule.yaml exists
        if (existsSync(SCHEDULE_FILE) && !options.force) {
          if (!isInteractive()) {
            console.error(chalk.red("✗ schedule.yaml already exists"));
            console.error(chalk.dim("  Use --force to overwrite"));
            process.exit(1);
          }
          const overwrite = await promptConfirm(
            "schedule.yaml exists. Overwrite?",
            false,
          );
          if (!overwrite) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        // 3. Gather schedule name
        let scheduleName = options.name;
        if (!scheduleName) {
          if (!isInteractive()) {
            console.error(
              chalk.red("✗ --name is required in non-interactive mode"),
            );
            process.exit(1);
          }
          scheduleName = await promptText(
            "Schedule name",
            `${agentName}-schedule`,
          );
          if (!scheduleName) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        // 4. Gather frequency
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
          frequency = await promptSelect<ScheduleFrequency>(
            "Schedule frequency",
            FREQUENCY_CHOICES,
            0,
          );
          if (!frequency) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        // 5. Gather day (for weekly/monthly)
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
              day = await promptSelect("Day of week", DAY_OF_WEEK_CHOICES, 0);
              if (day === undefined) {
                console.log(chalk.dim("Cancelled"));
                return;
              }
            } else {
              // Monthly - prompt for day number
              const dayStr = await promptText("Day of month (1-31)", "1");
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

        // 6. Gather time (for cron schedules)
        let time: string | undefined = options.time;
        let atTime: string | undefined;

        if (frequency === "once") {
          // One-time schedule needs ISO timestamp
          if (!isInteractive()) {
            console.error(
              chalk.red("✗ One-time schedules require interactive mode"),
            );
            console.error(
              chalk.dim("  Use cron frequency for non-interactive mode"),
            );
            process.exit(1);
          }

          // Step 1: Prompt for date (local timezone)
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

          // Step 2: Prompt for time (local timezone)
          const currentTime = getCurrentTimeLocal();
          time = await promptText(
            "Time (HH:MM)",
            currentTime,
            validateTimeFormat,
          );
          if (!time) {
            console.log(chalk.dim("Cancelled"));
            return;
          }

          // Combine date and time - will be converted to UTC with timezone later
          const dateStr = `${date} ${time}`;
          // Store for later conversion after timezone is gathered
          atTime = dateStr;
        } else {
          // Cron schedule needs time
          if (!time) {
            if (!isInteractive()) {
              console.error(chalk.red("✗ --time is required (HH:MM format)"));
              process.exit(1);
            }
            time = await promptText(
              "Time (HH:MM)",
              "09:00",
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

        // 7. Gather timezone
        const detectedTimezone = detectTimezone();
        let timezone = options.timezone;
        if (!timezone) {
          if (isInteractive()) {
            timezone = await promptText("Timezone", detectedTimezone);
            if (!timezone) {
              console.log(chalk.dim("Cancelled"));
              return;
            }
          } else {
            timezone = detectedTimezone;
          }
        }

        // For one-time schedules, atTime is already in "YYYY-MM-DD HH:MM" format
        // This human-readable format is stored in schedule.yaml
        // The deploy command will convert it to ISO format when sending to the API

        // 8. Gather prompt
        let promptText_ = options.prompt;
        if (!promptText_) {
          if (!isInteractive()) {
            console.error(chalk.red("✗ --prompt is required"));
            process.exit(1);
          }
          promptText_ = await promptText(
            "Prompt to run",
            "let's start working.",
          );
          if (!promptText_) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        // 9. Extract vars and secrets
        let vars: Record<string, string> | undefined;
        let secrets: Record<string, string> | undefined;

        if (options.vars) {
          const extracted = extractVarsAndSecrets();

          if (extracted.vars.length > 0 || extracted.secrets.length > 0) {
            let includeVars = true;
            if (isInteractive()) {
              const varCount = extracted.vars.length;
              const secretCount = extracted.secrets.length;
              const parts: string[] = [];
              if (varCount > 0) parts.push(`${varCount} variable(s)`);
              if (secretCount > 0) parts.push(`${secretCount} secret(s)`);
              const itemList = [
                ...extracted.vars.map((v) => `vars.${v}`),
                ...extracted.secrets.map((s) => `secrets.${s}`),
              ];
              includeVars =
                (await promptConfirm(
                  `Include ${parts.join(" and ")} from vm0.yaml? (${itemList.join(", ")})`,
                  true,
                )) ?? true;
            }

            if (includeVars) {
              if (extracted.vars.length > 0) {
                vars = {};
                for (const v of extracted.vars) {
                  vars[v] = `\${${v}}`;
                }
              }
              if (extracted.secrets.length > 0) {
                secrets = {};
                for (const s of extracted.secrets) {
                  secrets[s] = `\${${s}}`;
                }
              }
            }
          }
        }

        // 10. Build schedule.yaml content
        interface ScheduleYaml {
          version: "1.0";
          schedules: Record<
            string,
            {
              on: {
                cron?: string;
                at?: string;
                timezone: string;
              };
              run: {
                agent: string;
                prompt: string;
                vars?: Record<string, string>;
                secrets?: Record<string, string>;
              };
            }
          >;
        }

        const scheduleYaml: ScheduleYaml = {
          version: "1.0",
          schedules: {
            [scheduleName]: {
              on: {
                timezone,
              },
              run: {
                agent: agentName,
                prompt: promptText_,
              },
            },
          },
        };

        // Add trigger
        if (atTime) {
          scheduleYaml.schedules[scheduleName]!.on.at = atTime;
        } else if (time && frequency !== "once") {
          scheduleYaml.schedules[scheduleName]!.on.cron =
            generateCronExpression(frequency, time, day);
        }

        // Add vars and secrets
        if (vars && Object.keys(vars).length > 0) {
          scheduleYaml.schedules[scheduleName]!.run.vars = vars;
        }
        if (secrets && Object.keys(secrets).length > 0) {
          scheduleYaml.schedules[scheduleName]!.run.secrets = secrets;
        }

        // 11. Write file
        writeFileSync(SCHEDULE_FILE, stringifyYaml(scheduleYaml));
        console.log(chalk.green(`✓ Created ${SCHEDULE_FILE}`));
        console.log(chalk.dim("  Deploy with: vm0 schedule deploy"));
      } catch (error) {
        console.error(chalk.red("✗ Failed to create schedule.yaml"));
        if (error instanceof Error) {
          console.error(chalk.dim(`  ${error.message}`));
        }
        process.exit(1);
      }
    },
  );
