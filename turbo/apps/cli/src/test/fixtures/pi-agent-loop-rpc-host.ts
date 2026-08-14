import {
  createPiNodeExecutionEnv,
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
} from "../../lib/pi-agent-loop";

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error("The Pi RPC fixture requires a database path argument");
}

const executionEnv = await createPiNodeExecutionEnv();
const config = await piSandboxAgentConfigFromEnv();

await runPiSandboxAgentLoop({
  config: { ...config, databasePath },
  executionEnv,
});
