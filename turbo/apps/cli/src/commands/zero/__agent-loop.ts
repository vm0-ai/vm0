import { Command } from "commander";

import {
  createPiNodeExecutionEnv,
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
} from "../../lib/pi-agent-loop";

export const zeroAgentLoopCommand = new Command()
  .name("__agent-loop")
  .description("Internal sandbox Pi agent loop")
  .action(async () => {
    const executionEnv = await createPiNodeExecutionEnv();
    try {
      await runPiSandboxAgentLoop({
        config: await piSandboxAgentConfigFromEnv(),
        executionEnv,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      await executionEnv.cleanup();
    }
  });
