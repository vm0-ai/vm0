import { Command, InvalidArgumentError } from "commander";

import {
  createPiNodeExecutionEnv,
  DEFAULT_PI_STANDBY_TTL_SECONDS,
  piStandbyAgentConfigFromEnv,
  runPiStandbyAgentLoop,
  StdioPiAgentLoopIo,
} from "../../lib/pi-agent-loop";

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

export const zeroAgentLoopCommand = new Command()
  .name("__agent-loop")
  .description("Internal sandbox agent loop")
  .requiredOption("--standby", "Wait for a Pi handoff control")
  .option(
    "--standby-ttl-seconds <seconds>",
    "Fail when no persisted tool call appears before this duration",
    positiveInteger,
    DEFAULT_PI_STANDBY_TTL_SECONDS,
  )
  .action(async (options: { standby: true; standbyTtlSeconds: number }) => {
    const io = new StdioPiAgentLoopIo(process.stdin, process.stdout);
    const executionEnv = createPiNodeExecutionEnv();
    const abortController = new AbortController();
    const abortOnSigterm = () => {
      const error = new Error("Pi agent loop received SIGTERM");
      error.name = "AbortError";
      abortController.abort(error);
      io.close();
    };
    process.once("SIGTERM", abortOnSigterm);
    try {
      await runPiStandbyAgentLoop(
        {
          io,
          config: piStandbyAgentConfigFromEnv(),
          executionEnv,
          standbyTtlSeconds: options.standbyTtlSeconds,
        },
        abortController.signal,
      );
    } catch (error) {
      await io.write({
        type: "pi-error",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGTERM", abortOnSigterm);
      io.close();
      await executionEnv.cleanup();
    }
  });
