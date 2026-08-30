import { readFile } from "node:fs/promises";

import {
  CANONICAL_PI_SESSION_DIR,
  PI_AGENT_DIR,
  piLaunchPayloadSchema,
  piModelConfigSchema,
  type PiLaunchPayload,
} from "@okouai/api-contracts/contracts/runners";
import {
  runPiOfficialRpcMode,
  type PiAgentModelConfig,
} from "@okouai/pi-agent-runtime/node";

import { resolvePiApiFirstTurnHandoff } from "./pi-api-first-turn-handoff";

const RUN_ID_ENV = "OKOU_RUN_ID";
const PI_SESSION_ID_ENV = "OKOU_PI_SESSION_ID";
const PI_LAUNCH_PAYLOAD_FILE_ENV = "OKOU_PI_LAUNCH_PAYLOAD_FILE";
const PI_MODEL_CONFIG_ENV = "OKOU_PI_MODEL_CONFIG";
const PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE =
  "vm0_pi_api_first_turn_boundary";

export interface PiSandboxAgentConfig {
  readonly runId: string;
  readonly sessionId: string;
  readonly launchPayload: PiLaunchPayload;
  readonly model: PiAgentModelConfig;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required for Pi execution`);
  }
  return value;
}

function parseJsonEnv(env: NodeJS.ProcessEnv, name: string): unknown {
  const value = requiredEnv(env, name);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error });
  }
}

async function readLaunchPayload(
  env: NodeJS.ProcessEnv,
): Promise<PiLaunchPayload> {
  const path = requiredEnv(env, PI_LAUNCH_PAYLOAD_FILE_ENV);
  const raw = await readFile(path, "utf8");
  return piLaunchPayloadSchema.parse(JSON.parse(raw) as unknown);
}

async function writePiApiFirstTurnBoundaryControl(
  sandboxEventSequenceStart: number,
): Promise<void> {
  const line = `${JSON.stringify({
    type: PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
    schemaVersion: 1,
    sandboxEventSequenceStart,
  })}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error) {
        reject(
          new Error("Pi API first-turn boundary control could not be written", {
            cause: error,
          }),
        );
      } else {
        resolve();
      }
    });
  });
}

/**
 * Resolve immutable Pi runtime inputs injected by guest-agent.
 *
 * Prompt-sized inputs arrive through the private launch payload file rather
 * than the child environment, so this reads that file before the first turn.
 */
export async function piSandboxAgentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiSandboxAgentConfig> {
  const runId = requiredEnv(env, RUN_ID_ENV);
  const parsedModel = piModelConfigSchema.parse(
    parseJsonEnv(env, PI_MODEL_CONFIG_ENV),
  );
  const {
    apiKeyEnv,
    credentialSecretName: _credentialSecretName,
    ...model
  } = parsedModel;
  const apiKey = requiredEnv(env, apiKeyEnv);
  return {
    runId,
    sessionId: requiredEnv(env, PI_SESSION_ID_ENV),
    launchPayload: await readLaunchPayload(env),
    model: { ...model, apiKey },
  };
}

/**
 * Resolve the API-first handoff and run the official sandbox-owned Pi RPC host.
 *
 * The handoff resolver validates the immutable manifest and restored H1
 * session, maps manifest v1 to sequence 1 or reads the manifest v2 sequence,
 * and returns the session file plus the authoritative first Sandbox event
 * sequence. This host then writes one private JSONL startup-control record with
 * that sequence before entering `runPiOfficialRpcMode`.
 *
 * The guest-agent consumes that control record before admitting any official
 * Pi RPC record, so the control is not an agent event, Chat event, transcript
 * line, or public delivery. `runPiOfficialRpcMode` owns the official RPC
 * command/record stream; guest-agent owns its stdin and keeps it open through
 * `agent_settled`, closing it only after terminal handling and active-input
 * quiescence. The host consequently remains in official RPC mode until the
 * guest closes stdin.
 */
export async function runPiSandboxAgentLoop(args: {
  readonly config: PiSandboxAgentConfig;
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly sessionDir?: string;
}): Promise<void> {
  const sessionDir = args.sessionDir ?? CANONICAL_PI_SESSION_DIR;
  const handoff = await resolvePiApiFirstTurnHandoff({
    config: args.config.launchPayload.launchConfig.apiFirstTurn,
    sessionDir,
    sessionId: args.config.sessionId,
  });
  await writePiApiFirstTurnBoundaryControl(handoff.sandboxEventSequenceStart);
  return await runPiOfficialRpcMode({
    sessionId: args.config.sessionId,
    sessionDir,
    cwd: args.cwd ?? process.cwd(),
    agentDir: args.agentDir ?? PI_AGENT_DIR,
    model: args.config.model,
    appendSystemPrompt: args.config.launchPayload.appendSystemPrompt,
    sessionFile: handoff.sessionFile,
  });
}
