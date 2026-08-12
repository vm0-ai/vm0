import { Command } from "commander";

import {
  createPiNodeExecutionEnv,
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
  StdioPiAgentLoopIo,
} from "../../lib/pi-agent-loop";

export const zeroAgentLoopCommand = new Command()
  .name("__agent-loop")
  .description("Internal sandbox Pi agent loop")
  .action(async () => {
    const io = new StdioPiAgentLoopIo(process.stdin, process.stdout);
    const executionEnv = await createPiNodeExecutionEnv();
    const abortController = new AbortController();
    const abortOnSigterm = () => {
      const error = new Error("Pi agent loop received SIGTERM");
      error.name = "AbortError";
      abortController.abort(error);
      io.close();
    };
    process.once("SIGTERM", abortOnSigterm);
    try {
      process.exitCode = await runPiSandboxAgentLoop(
        {
          io,
          config: piSandboxAgentConfigFromEnv(),
          executionEnv,
        },
        abortController.signal,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGTERM", abortOnSigterm);
      io.close();
      await executionEnv.cleanup();
    }
  });
