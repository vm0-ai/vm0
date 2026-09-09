import {
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
} from "../../lib/pi-agent-loop";

const agentDir = process.argv[2];
const sessionDir = process.argv[3];
if (!agentDir || !sessionDir) {
  throw new Error("The Pi RPC fixture requires agent and session directories");
}

const config = await piSandboxAgentConfigFromEnv();

await runPiSandboxAgentLoop({
  config,
  agentDir,
  sessionDir,
  memoryRoot: process.argv[4],
});

const completionBarrierUrl = process.argv[5];
if (completionBarrierUrl) {
  const response = await fetch(completionBarrierUrl, { method: "POST" });
  if (!response.ok) {
    throw new Error("The maintenance completion barrier failed");
  }
}
