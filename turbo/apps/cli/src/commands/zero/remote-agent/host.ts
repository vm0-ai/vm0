import { hostname } from "os";
import { Command } from "commander";
import chalk from "chalk";
import type { RemoteAgentBackend } from "@vm0/api-contracts/contracts/zero-remote-agent";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  claimNextRemoteAgentHostJob,
  completeRemoteAgentHostJob,
  pollRemoteAgentDevice,
  sendRemoteAgentHeartbeat,
  startRemoteAgentDevice,
} from "../../../lib/api";
import { getBaseUrl } from "../../../lib/api/core/client-factory";
import { saveRemoteAgentHost } from "../../../lib/api/config";
import {
  detectRemoteAgentBackends,
  executeRemoteAgentBackend,
} from "../../../lib/remote-agent/backends";

const HEARTBEAT_INTERVAL_MS = 30_000;
const JOB_POLL_INTERVAL_MS = 2_000;

interface HostStartOptions {
  name?: string;
  workdir?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backendLabel(backend: RemoteAgentBackend): string {
  if (backend === "claude-code") return "Claude Code";
  return "Codex";
}

function resolveVerificationUrl(baseUrl: string, path: string): string {
  const override = process.env.VM0_WEB_URL;
  const webBaseUrl = override ?? baseUrl;
  const url = new URL(
    path,
    webBaseUrl.endsWith("/") ? webBaseUrl : `${webBaseUrl}/`,
  );
  if (url.hostname === "api.vm0.ai") {
    url.hostname = "www.vm0.ai";
  }
  return url.href;
}

async function waitForPairing(params: {
  deviceCode: string;
  pollToken: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}): Promise<{ hostId: string; hostToken: string }> {
  const deadline = Date.now() + params.expiresInSeconds * 1000;

  while (Date.now() <= deadline) {
    await sleep(params.intervalSeconds * 1000);
    const result = await pollRemoteAgentDevice({
      deviceCode: params.deviceCode,
      pollToken: params.pollToken,
    });

    if (result.status === "pending") {
      if (process.stdout.isTTY) process.stdout.write(".");
      continue;
    }

    if (result.status === "expired") {
      throw new Error("Device code expired. Start the host again.");
    }

    if (!result.hostToken) {
      throw new Error("Device pairing was already consumed. Start again.");
    }

    if (process.stdout.isTTY) process.stdout.write("\n");
    return { hostId: result.hostId, hostToken: result.hostToken };
  }

  throw new Error("Device code expired. Start the host again.");
}

async function runHostLoop(params: {
  hostToken: string;
  hostName: string;
  supportedBackends: RemoteAgentBackend[];
  workdir: string;
}): Promise<void> {
  let latestError: string | null = null;
  let stopped = false;
  let nextHeartbeatAt = 0;

  const onStop = () => {
    stopped = true;
  };

  const sendHeartbeat = async (): Promise<void> => {
    try {
      await sendRemoteAgentHeartbeat(params);
      nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
      latestError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== latestError) {
        console.log(chalk.yellow(`Heartbeat failed: ${message}`));
      }
      latestError = message;
    }
  };

  await sendHeartbeat();

  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  try {
    while (!stopped) {
      if (Date.now() >= nextHeartbeatAt) {
        await sendHeartbeat();
      }

      let nextJob;
      try {
        nextJob = await claimNextRemoteAgentHostJob({
          hostToken: params.hostToken,
          supportedBackends: params.supportedBackends,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.yellow(`Job poll failed: ${message}`));
        await sleep(JOB_POLL_INTERVAL_MS);
        continue;
      }

      if (nextJob.status === "idle") {
        await sleep(JOB_POLL_INTERVAL_MS);
        continue;
      }

      console.log(
        chalk.cyan(
          `Running ${backendLabel(nextJob.job.backend)} job ${nextJob.job.id}`,
        ),
      );

      const result = await executeRemoteAgentBackend({
        backend: nextJob.job.backend,
        prompt: nextJob.job.prompt,
        workdir: params.workdir,
      });

      await completeRemoteAgentHostJob({
        hostToken: params.hostToken,
        jobId: nextJob.job.id,
        status: result.exitCode === 0 ? "succeeded" : "failed",
        output: result.output,
        error: result.error,
        exitCode: result.exitCode,
      });

      const status =
        result.exitCode === 0 ? chalk.green("completed") : chalk.red("failed");
      console.log(`${status} ${nextJob.job.id}`);
    }
  } finally {
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
  }
}

export const hostStartCommand = new Command()
  .name("start")
  .description("Start the remote-agent host daemon")
  .option("--name <name>", "Display name for this host")
  .option("--workdir <path>", "Working directory for Codex/Claude jobs")
  .action(
    withErrorHandler(async (options: HostStartOptions) => {
      const hostName = options.name?.trim() || hostname();
      const workdir = options.workdir?.trim() || process.cwd();

      console.log(chalk.cyan("Detecting local agent CLIs..."));
      const probes = await detectRemoteAgentBackends();
      const available = probes.filter((probe) => {
        return probe.available;
      });
      const supportedBackends = available.map((probe) => {
        return probe.backend;
      });

      if (supportedBackends.length === 0) {
        throw new Error(
          "No supported agent CLI found. Install Codex CLI (`codex`) or Claude Code (`claude`) before starting remote-agent host.",
        );
      }

      for (const probe of available) {
        const version = probe.version ? ` (${probe.version})` : "";
        console.log(
          `  ${backendLabel(probe.backend)}: ${probe.command}${version}`,
        );
      }

      console.log();
      console.log(chalk.cyan("Starting remote-agent pairing..."));
      const pairing = await startRemoteAgentDevice({
        hostName,
        supportedBackends,
      });
      const baseUrl = await getBaseUrl();
      const verificationUrl = resolveVerificationUrl(
        baseUrl,
        pairing.verificationPath,
      );

      console.log();
      console.log(`  Device code: ${chalk.bold(pairing.userCode)}`);
      console.log(`  Connect: zero remote-agent connect ${pairing.userCode}`);
      console.log(`  Browser: ${verificationUrl}`);
      console.log();
      console.log(chalk.dim("Waiting for the device code to be connected"));

      const linked = await waitForPairing({
        deviceCode: pairing.deviceCode,
        pollToken: pairing.pollToken,
        intervalSeconds: pairing.interval,
        expiresInSeconds: pairing.expiresIn,
      });

      await saveRemoteAgentHost({
        id: linked.hostId,
        token: linked.hostToken,
        apiUrl: baseUrl,
        hostName,
        supportedBackends,
        linkedAt: new Date().toISOString(),
      });

      console.log(chalk.green("Remote-agent host linked"));
      console.log(`Workdir: ${workdir}`);
      console.log(chalk.dim("Press ^C to stop"));
      console.log();

      await runHostLoop({
        hostToken: linked.hostToken,
        hostName,
        supportedBackends,
        workdir,
      });

      console.log();
      console.log(chalk.green("Remote-agent host stopped"));
    }),
  );
