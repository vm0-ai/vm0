import { Command } from "commander";
import chalk from "chalk";
import type {
  RemoteAgentJobStatus,
  RemoteAgentRunListItem,
  RemoteAgentRunResponse,
} from "@vm0/api-contracts/contracts/zero-remote-agent";
import { getRemoteAgentRun, listRemoteAgentRuns } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

const VALID_STATUSES: readonly RemoteAgentJobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
];

interface RunsListOptions {
  status?: string;
  host?: string;
  hostId?: string;
  limit?: string;
  json?: boolean;
}

interface JsonOption {
  json?: boolean;
}

function formatStatus(status: RemoteAgentJobStatus): string {
  switch (status) {
    case "queued":
      return chalk.yellow(status);
    case "running":
      return chalk.green(status);
    case "succeeded":
      return chalk.dim(status);
    case "failed":
      return chalk.red(status);
  }
}

function formatTime(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function parseStatus(
  value: string | undefined,
): RemoteAgentJobStatus | undefined {
  if (!value) return undefined;
  if (!VALID_STATUSES.includes(value as RemoteAgentJobStatus)) {
    throw new Error(
      `Invalid status "${value}". Valid values: ${VALID_STATUSES.join(",")}`,
    );
  }
  return value as RemoteAgentJobStatus;
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be between 1 and 100");
  }
  return limit;
}

function printRunTable(runs: readonly RemoteAgentRunListItem[]): void {
  if (runs.length === 0) {
    console.log(chalk.dim("No remote-agent runs found"));
    console.log(chalk.dim('  Run: zero remote-agent run "your prompt"'));
    return;
  }

  const rows = runs.map((run) => {
    return {
      id: run.id,
      status: formatStatus(run.status),
      host: run.hostName ?? run.hostId ?? "-",
      backend: run.backend ?? "-",
      created: formatTime(run.createdAt),
      prompt: truncate(run.prompt.replace(/\s+/g, " "), 60),
    };
  });

  const idWidth = Math.max(
    "JOB ID".length,
    ...rows.map((row) => {
      return row.id.length;
    }),
  );
  const statusWidth = Math.max(
    "STATUS".length,
    ...runs.map((run) => {
      return run.status.length;
    }),
  );
  const hostWidth = Math.max(
    "HOST".length,
    ...rows.map((row) => {
      return row.host.length;
    }),
  );
  const backendWidth = Math.max(
    "BACKEND".length,
    ...rows.map((row) => {
      return row.backend.length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "JOB ID".padEnd(idWidth),
        "STATUS".padEnd(statusWidth),
        "HOST".padEnd(hostWidth),
        "BACKEND".padEnd(backendWidth),
        "CREATED".padEnd(20),
        "PROMPT",
      ].join("  "),
    ),
  );

  for (const row of rows) {
    console.log(
      [
        row.id.padEnd(idWidth),
        row.status.padEnd(statusWidth),
        row.host.padEnd(hostWidth),
        row.backend.padEnd(backendWidth),
        row.created.padEnd(20),
        row.prompt,
      ].join("  "),
    );
  }
}

function printRunStatus(job: RemoteAgentRunResponse): void {
  console.log(`Job: ${job.id}`);
  console.log(`Status: ${formatStatus(job.status)}`);
  console.log(`Host: ${job.hostId ?? "-"}`);
  console.log(`Backend: ${job.backend ?? "-"}`);
  console.log(`Created: ${formatTime(job.createdAt)}`);
  console.log(`Started: ${formatTime(job.startedAt)}`);
  console.log(`Completed: ${formatTime(job.completedAt)}`);
  console.log(`Exit code: ${job.exitCode ?? "-"}`);

  if (job.status === "succeeded" || job.status === "failed") {
    console.log();
    console.log(chalk.dim(`  Run: zero remote-agent runs result ${job.id}`));
  }
}

function printRunResult(job: RemoteAgentRunResponse): void {
  if (job.status === "queued" || job.status === "running") {
    throw new Error(`Remote-agent job is ${job.status}`, {
      cause: new Error(`Run: zero remote-agent runs status ${job.id}`),
    });
  }

  if (job.status === "failed") {
    if (job.error) {
      console.error(chalk.red(job.error));
    }
    process.exitCode = job.exitCode ?? 1;
    return;
  }

  if (job.output) {
    console.log(job.output);
  }
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List remote-agent runs")
  .option("--status <status>", `Filter by status: ${VALID_STATUSES.join(",")}`)
  .option("--host <name>", "Filter by remote-agent host name")
  .option("--host-id <id>", "Filter by remote-agent host id")
  .option("--limit <n>", "Maximum number of results (default: 20, max: 100)")
  .option("--json", "Output JSON")
  .action(
    withErrorHandler(async (options: RunsListOptions) => {
      const result = await listRemoteAgentRuns({
        status: parseStatus(options.status),
        hostName: options.host,
        hostId: options.hostId,
        limit: parseLimit(options.limit),
      });

      if (options.json) {
        console.log(JSON.stringify(result));
        return;
      }

      printRunTable(result.runs);
    }),
  );

const statusCommand = new Command()
  .name("status")
  .description("Show remote-agent run status")
  .argument("<job-id>", "Remote-agent job id")
  .option("--json", "Output JSON")
  .action(
    withErrorHandler(async (jobId: string, options: JsonOption) => {
      const job = await getRemoteAgentRun(jobId);
      if (options.json) {
        console.log(JSON.stringify(job));
        return;
      }

      printRunStatus(job);
    }),
  );

const resultCommand = new Command()
  .name("result")
  .description("Print remote-agent run result")
  .argument("<job-id>", "Remote-agent job id")
  .option("--json", "Output JSON")
  .action(
    withErrorHandler(async (jobId: string, options: JsonOption) => {
      const job = await getRemoteAgentRun(jobId);
      if (options.json) {
        console.log(JSON.stringify(job));
        return;
      }

      printRunResult(job);
    }),
  );

export const runsCommand = new Command()
  .name("runs")
  .description("List and inspect remote-agent runs")
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addCommand(resultCommand);
