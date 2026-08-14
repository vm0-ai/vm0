import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_PI_SESSION_DATABASE_PATH,
  PI_SKILLS_ROOT,
} from "@okouai/api-contracts/contracts/runners";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  piSandboxAgentConfigFromEnv,
  type PiSandboxAgentConfig,
} from "./pi-agent-loop";

const RUN_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG: PiSandboxAgentConfig = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  launchPayload: {
    schemaVersion: 1,
    appendSystemPrompt: "exact immutable Pi append prompt",
    launchConfig: {
      schemaVersion: 1,
      agentName: "Sandbox Test Agent",
      skillSnapshot: {
        schemaVersion: 1,
        policyVersion: 1,
        root: PI_SKILLS_ROOT,
        digest: `sha256:${"0".repeat(64)}`,
        entries: [],
      },
      agentInstructionsPath: null,
      memory: null,
    },
  },
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-v4-flash",
    apiKey: "test-api-key",
  },
  databasePath: CANONICAL_PI_SESSION_DATABASE_PATH,
};

let launchPayloadDirectory = "";
let launchPayloadFile = "";

beforeEach(async () => {
  launchPayloadDirectory = await mkdtemp(join(tmpdir(), "vm0-pi-launch-"));
  launchPayloadFile = join(launchPayloadDirectory, "payload.json");
  await writeFile(launchPayloadFile, JSON.stringify(CONFIG.launchPayload));
});

afterEach(async () => {
  await rm(launchPayloadDirectory, { recursive: true, force: true });
});

function piEnv(runIdEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...runIdEnv,
    OKOU_PI_SESSION_ID: SESSION_ID,
    OKOU_PI_LAUNCH_PAYLOAD_FILE: launchPayloadFile,
    OKOU_PI_MODEL_CONFIG: JSON.stringify({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
    }),
    OPENAI_API_KEY: "test-api-key",
  };
}

describe("sandbox Pi agent loop", () => {
  it("resolves the Pi session, launch payload file, and model credential", async () => {
    await expect(
      piSandboxAgentConfigFromEnv(
        piEnv({
          OKOU_RUN_ID: RUN_ID,
        }),
      ),
    ).resolves.toEqual(CONFIG);
  });

  it("uses the canonical name when the run id is missing", async () => {
    await expect(piSandboxAgentConfigFromEnv(piEnv({}))).rejects.toThrowError(
      "OKOU_RUN_ID is required for Pi execution",
    );
  });

  it("requires the launch payload file instead of an inline launch config", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    delete env.OKOU_PI_LAUNCH_PAYLOAD_FILE;

    await expect(piSandboxAgentConfigFromEnv(env)).rejects.toThrowError(
      "OKOU_PI_LAUNCH_PAYLOAD_FILE is required for Pi execution",
    );
  });

  it("names the canonical variable without exposing invalid model config", async () => {
    const invalidModelConfig = "credential-like-model-config{";
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    env.OKOU_PI_MODEL_CONFIG = invalidModelConfig;

    await expect(piSandboxAgentConfigFromEnv(env)).rejects.toThrowError(
      "OKOU_PI_MODEL_CONFIG must contain valid JSON",
    );
    try {
      await piSandboxAgentConfigFromEnv(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(invalidModelConfig);
    }
  });
});
