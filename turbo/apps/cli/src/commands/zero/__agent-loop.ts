import { Command } from "commander";

import {
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
} from "../../lib/pi-agent-loop";

export const zeroAgentLoopCommand = new Command()
  .name("__agent-loop")
  .description("Internal sandbox Pi agent loop")
  .action(async () => {
    try {
      await runPiSandboxAgentLoop({
        config: await piSandboxAgentConfigFromEnv(),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
