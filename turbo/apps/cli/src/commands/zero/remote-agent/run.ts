import { Command } from "commander";
import chalk from "chalk";
import type { RemoteAgentBackend } from "@vm0/api-contracts/contracts/zero-remote-agent";
import { createRemoteAgentRun, getRemoteAgentRun } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

interface RunOptions {
  backend?: string;
  hostId?: string;
  timeout?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseBackend(value: string | undefined): RemoteAgentBackend {
  if (!value || value === "codex") {
    return "codex";
  }
  if (value === "claude-code" || value === "claude") {
    return "claude-code";
  }
  throw new Error("Backend must be one of: codex, claude-code");
}

function parseTimeoutSeconds(value: string | undefined): number {
  if (!value) return 600;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Timeout must be a positive number of seconds");
  }
  return seconds;
}

export const runCommand = new Command()
  .name("run")
  .description("Run Codex or Claude on a connected remote-agent host")
  .argument("<prompt...>", "Prompt to send to the remote agent")
  .option("--backend <backend>", "codex or claude-code", "codex")
  .option("--host-id <id>", "Specific remote-agent host id")
  .option("--timeout <seconds>", "Maximum time to wait", "600")
  .action(
    withErrorHandler(async (promptParts: string[], options: RunOptions) => {
      const backend = parseBackend(options.backend);
      const timeoutSeconds = parseTimeoutSeconds(options.timeout);
      const prompt = promptParts.join(" ").trim();
      if (!prompt) {
        throw new Error("Prompt is required");
      }

      const created = await createRemoteAgentRun({
        backend,
        prompt,
        hostId: options.hostId,
      });

      console.log(chalk.cyan(`Remote-agent job queued: ${created.jobId}`));

      const deadline = Date.now() + timeoutSeconds * 1000;
      while (Date.now() <= deadline) {
        const job = await getRemoteAgentRun(created.jobId);
        if (job.status === "queued" || job.status === "running") {
          if (process.stdout.isTTY) {
            process.stdout.write(".");
          }
          await sleep(2_000);
          continue;
        }

        if (process.stdout.isTTY) {
          process.stdout.write("\n");
        }

        if (job.output) {
          console.log(job.output);
        }
        if (job.status === "failed") {
          if (job.error) {
            console.error(chalk.red(job.error));
          }
          process.exitCode = job.exitCode ?? 1;
        }
        return;
      }

      throw new Error(`Remote-agent job timed out: ${created.jobId}`);
    }),
  );
