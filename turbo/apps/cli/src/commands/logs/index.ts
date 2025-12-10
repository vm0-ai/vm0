import { Command } from "commander";
import chalk from "chalk";
import { apiClient, TelemetryMetric } from "../../lib/api-client";

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Format a single metric line
 */
function formatMetric(metric: TelemetryMetric): string {
  const memPercent = ((metric.mem_used / metric.mem_total) * 100).toFixed(1);
  const diskPercent = ((metric.disk_used / metric.disk_total) * 100).toFixed(1);

  return `[${metric.ts}] CPU: ${metric.cpu.toFixed(1)}% | Mem: ${formatBytes(metric.mem_used)}/${formatBytes(metric.mem_total)} (${memPercent}%) | Disk: ${formatBytes(metric.disk_used)}/${formatBytes(metric.disk_total)} (${diskPercent}%)`;
}

export const logsCommand = new Command()
  .name("logs")
  .description("View telemetry logs for an agent run")
  .argument("<runId>", "Run ID to fetch logs for")
  .option("-s, --system", "Show system log only")
  .option("-m, --metrics", "Show metrics only")
  .option("-j, --json", "Output in JSON format")
  .action(
    async (
      runId: string,
      options: { system?: boolean; metrics?: boolean; json?: boolean },
    ) => {
      try {
        const telemetry = await apiClient.getTelemetry(runId);

        // JSON output mode
        if (options.json) {
          console.log(JSON.stringify(telemetry, null, 2));
          return;
        }

        // Determine what to show
        const showSystem =
          options.system || (!options.system && !options.metrics);
        const showMetrics =
          options.metrics || (!options.system && !options.metrics);

        // Show system log
        if (showSystem && telemetry.systemLog) {
          if (showMetrics && telemetry.metrics.length > 0) {
            console.log(chalk.cyan("=== System Log ==="));
          }
          console.log(telemetry.systemLog);
        }

        // Show metrics
        if (showMetrics && telemetry.metrics.length > 0) {
          if (showSystem && telemetry.systemLog) {
            console.log();
            console.log(chalk.cyan("=== Metrics ==="));
          }
          for (const metric of telemetry.metrics) {
            console.log(formatMetric(metric));
          }
        }

        // Handle empty case
        if (!telemetry.systemLog && telemetry.metrics.length === 0) {
          console.log(
            chalk.yellow("No telemetry data available for this run."),
          );
        }
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(chalk.red("Not authenticated. Run: vm0 auth login"));
          } else if (error.message.includes("not found")) {
            console.error(chalk.red(`Run not found: ${runId}`));
          } else {
            console.error(chalk.red("Failed to fetch logs"));
            console.error(chalk.gray(`  ${error.message}`));
          }
        } else {
          console.error(chalk.red("An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
