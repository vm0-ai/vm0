import { Command } from "commander";

import {
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
  reportPiSandboxAgentLoopFailure,
} from "../lib/pi-agent-loop";

export const agentLoopCommand = new Command()
  .name("__agent-loop")
  .description("Internal sandbox Pi agent loop")
  .action(async () => {
    try {
      await runPiSandboxAgentLoop({
        config: await piSandboxAgentConfigFromEnv(),
      });
    } catch (error) {
      reportPiSandboxAgentLoopFailure(error);
    }
  });
