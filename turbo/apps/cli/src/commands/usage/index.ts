import { Command } from "commander";
import chalk from "chalk";
import { getUsage } from "../../lib/api";
import { parseTime } from "../../lib/utils/time-parser";
import { formatDuration } from "../../lib/utils/duration-formatter";

/**
 * Maximum time range allowed (30 days in milliseconds)
 */
const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default time range (7 days in milliseconds)
 */
const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Format a date for display (e.g., "Jan 19")
 */
function formatDateDisplay(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Format a date range for the header (e.g., "Jan 13 - Jan 19, 2026")
 */
function formatDateRange(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);

  // Subtract 1 day from end since it's exclusive
  endDate.setDate(endDate.getDate() - 1);

  const startStr = startDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const endStr = endDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `${startStr} - ${endStr}`;
}

/**
 * Fill in missing dates in the daily array
 */
function fillMissingDates(
  daily: Array<{ date: string; run_count: number; run_time_ms: number }>,
  startDate: Date,
  endDate: Date,
): Array<{ date: string; run_count: number; run_time_ms: number }> {
  const dateMap = new Map<
    string,
    { date: string; run_count: number; run_time_ms: number }
  >();

  // Index existing data by date
  for (const day of daily) {
    dateMap.set(day.date, day);
  }

  // Generate all dates in range
  const result: Array<{
    date: string;
    run_count: number;
    run_time_ms: number;
  }> = [];
  const current = new Date(startDate);
  current.setUTCHours(0, 0, 0, 0);

  while (current < endDate) {
    const dateStr = current.toISOString().split("T")[0]!;
    const existing = dateMap.get(dateStr);

    if (existing) {
      result.push(existing);
    } else {
      result.push({ date: dateStr, run_count: 0, run_time_ms: 0 });
    }

    current.setDate(current.getDate() + 1);
  }

  // Sort by date descending (most recent first)
  result.sort((a, b) => b.date.localeCompare(a.date));

  return result;
}

export const usageCommand = new Command()
  .name("usage")
  .description("View usage statistics")
  .option("--since <date>", "Start date (ISO format or relative: 7d, 30d)")
  .option(
    "--until <date>",
    "End date (ISO format or relative, defaults to now)",
  )
  .action(async (options: { since?: string; until?: string }) => {
    try {
      // Calculate date range
      const now = new Date();
      let endDate: Date;
      let startDate: Date;

      if (options.until) {
        try {
          const untilMs = parseTime(options.until);
          endDate = new Date(untilMs);
        } catch {
          console.error(
            chalk.red(
              "✗ Invalid --until format. Use ISO (2026-01-01) or relative (7d, 30d)",
            ),
          );
          process.exit(1);
        }
      } else {
        endDate = now;
      }

      if (options.since) {
        try {
          const sinceMs = parseTime(options.since);
          startDate = new Date(sinceMs);
        } catch {
          console.error(
            chalk.red(
              "✗ Invalid --since format. Use ISO (2026-01-01) or relative (7d, 30d)",
            ),
          );
          process.exit(1);
        }
      } else {
        startDate = new Date(endDate.getTime() - DEFAULT_RANGE_MS);
      }

      // Validate date range
      if (startDate >= endDate) {
        console.error(chalk.red("✗ --since must be before --until"));
        process.exit(1);
      }

      const rangeMs = endDate.getTime() - startDate.getTime();
      if (rangeMs > MAX_RANGE_MS) {
        console.error(
          chalk.red(
            "✗ Time range exceeds maximum of 30 days. Use --until to specify an end date",
          ),
        );
        process.exit(1);
      }

      // Fetch usage data
      const usage = await getUsage({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });

      // Fill in missing dates
      const filledDaily = fillMissingDates(
        usage.daily,
        new Date(usage.period.start),
        new Date(usage.period.end),
      );

      // Print header
      console.log();
      console.log(
        chalk.bold(
          `Usage Summary (${formatDateRange(usage.period.start, usage.period.end)})`,
        ),
      );
      console.log();

      // Print column headers
      console.log(chalk.dim("DATE        RUNS    RUN TIME"));

      // Print each day
      for (const day of filledDaily) {
        const dateDisplay = formatDateDisplay(day.date).padEnd(10);
        const runsDisplay = String(day.run_count).padStart(6);
        const timeDisplay = formatDuration(day.run_time_ms);

        console.log(`${dateDisplay}${runsDisplay}    ${timeDisplay}`);
      }

      // Print separator and totals
      console.log(chalk.dim("─".repeat(29)));
      const totalRunsDisplay = String(usage.summary.total_runs).padStart(6);
      const totalTimeDisplay = formatDuration(usage.summary.total_run_time_ms);
      console.log(
        `${"TOTAL".padEnd(10)}${totalRunsDisplay}    ${totalTimeDisplay}`,
      );
      console.log();
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated"));
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
