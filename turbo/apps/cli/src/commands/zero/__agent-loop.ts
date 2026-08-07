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
    "Release an unused standby process after this duration",
    positiveInteger,
    DEFAULT_PI_STANDBY_TTL_SECONDS,
  )
  .action(async (options: { standby: true; standbyTtlSeconds: number }) => {
    const io = new StdioPiAgentLoopIo(process.stdin, process.stdout);
    const executionEnv = createPiNodeExecutionEnv();
    try {
      await runPiStandbyAgentLoop({
        io,
        config: piStandbyAgentConfigFromEnv(),
        executionEnv,
        signal: new AbortController().signal,
        standbyTtlSeconds: options.standbyTtlSeconds,
      });
    } catch (error) {
      await io.write({
        type: "pi-error",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    } finally {
      io.close();
      await executionEnv.cleanup();
    }
  });
