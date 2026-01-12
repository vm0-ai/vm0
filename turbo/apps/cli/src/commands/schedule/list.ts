import { Command } from "commander";
import chalk from "chalk";
import { apiClient, type ApiError } from "../../lib/api-client";

/**
 * Schedule response from API
 */
interface ScheduleResponse {
  id: string;
  name: string;
  cronExpression: string | null;
  atTime: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  composeName: string;
  scopeSlug: string;
}

interface ListResponse {
  schedules: ScheduleResponse[];
}

/**
 * Format relative time
 */
function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffAbs = Math.abs(diffMs);

  const minutes = Math.floor(diffAbs / (1000 * 60));
  const hours = Math.floor(diffAbs / (1000 * 60 * 60));
  const days = Math.floor(diffAbs / (1000 * 60 * 60 * 24));

  const isPast = diffMs < 0;

  if (days > 0) {
    return isPast ? `${days}d ago` : `in ${days}d`;
  } else if (hours > 0) {
    return isPast ? `${hours}h ago` : `in ${hours}h`;
  } else if (minutes > 0) {
    return isPast ? `${minutes}m ago` : `in ${minutes}m`;
  } else {
    return isPast ? "just now" : "soon";
  }
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all schedules")
  .action(async () => {
    try {
      const response = await apiClient.get("/api/agent/schedules");

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "List failed");
      }

      const result = (await response.json()) as ListResponse;

      if (result.schedules.length === 0) {
        console.log(chalk.dim("No schedules found"));
        console.log(
          chalk.dim("  Create one with: vm0 schedule deploy schedule.yaml"),
        );
        return;
      }

      // Calculate column widths
      const nameWidth = Math.max(
        4,
        ...result.schedules.map((s) => s.name.length),
      );
      const agentWidth = Math.max(
        5,
        ...result.schedules.map((s) => s.composeName.length),
      );
      const triggerWidth = Math.max(
        7,
        ...result.schedules.map((s) =>
          s.cronExpression
            ? s.cronExpression.length + s.timezone.length + 3
            : s.atTime?.length || 0,
        ),
      );

      // Print header
      const header = [
        "NAME".padEnd(nameWidth),
        "AGENT".padEnd(agentWidth),
        "TRIGGER".padEnd(triggerWidth),
        "STATUS".padEnd(8),
        "NEXT RUN",
      ].join("  ");
      console.log(chalk.dim(header));

      // Print rows
      for (const schedule of result.schedules) {
        const trigger = schedule.cronExpression
          ? `${schedule.cronExpression} (${schedule.timezone})`
          : schedule.atTime || "-";

        const status = schedule.enabled
          ? chalk.green("enabled")
          : chalk.yellow("disabled");

        const nextRun = schedule.enabled
          ? formatRelativeTime(schedule.nextRunAt)
          : "-";

        const row = [
          schedule.name.padEnd(nameWidth),
          schedule.composeName.padEnd(agentWidth),
          trigger.padEnd(triggerWidth),
          status.padEnd(8 + (schedule.enabled ? 0 : 2)), // Account for chalk chars
          nextRun,
        ].join("  ");
        console.log(row);
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to list schedules"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
