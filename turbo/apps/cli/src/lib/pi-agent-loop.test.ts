import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_PI_SESSION_DATABASE_PATH,
  PI_SKILLS_ROOT,
} from "@okouai/api-contracts/contracts/runners";
import {
  runPiAgentSession,
  type PiAssistantMessage,
} from "@okouai/pi-agent-runtime/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPiNodeExecutionEnv,
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
  type PiAgentLoopIo,
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

const ZERO_USAGE = {
  input: 5,
  output: 3,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: PiAssistantMessage["content"],
  stopReason: PiAssistantMessage["stopReason"] = "stop",
): PiAssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    responseId: "response-1",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: 1,
  };
}

class FakeIo implements PiAgentLoopIo {
  readonly outputs: Array<Record<string, unknown>> = [];
  readonly #inputs: unknown[];

  constructor(inputs: unknown[]) {
    this.#inputs = [...inputs];
  }

  async read(): Promise<unknown | null> {
    return this.#inputs.shift() ?? null;
  }

  async write(frame: Readonly<Record<string, unknown>>): Promise<void> {
    this.outputs.push({ ...frame });
  }
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

  it("runs one native SQLite turn and emits only the chat projection", async () => {
    const io = new FakeIo([
      {
        type: "user",
        message: { role: "user", content: "persist this turn" },
      },
    ]);
    const executionEnv = await createPiNodeExecutionEnv();
    const finalMessage = assistantMessage([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "Sandbox answer." },
    ]);
    let receivedPrompt: string | undefined;
    let receivedSystemPrompt: string | undefined;
    let receivedDatabasePath: string | undefined;
    const runSession: typeof runPiAgentSession = async (args) => {
      receivedPrompt = args.prompt;
      receivedSystemPrompt = args.systemPrompt;
      receivedDatabasePath = args.databasePath;
      await args.onAssistantMessage?.(finalMessage);
      return {
        messages: [finalMessage],
        finalAssistantMessage: finalMessage,
      };
    };

    try {
      await expect(
        runPiSandboxAgentLoop(
          { io, config: CONFIG, executionEnv, runSession },
          new AbortController().signal,
        ),
      ).resolves.toBe(0);
    } finally {
      await executionEnv.cleanup();
    }

    expect(receivedPrompt).toBe("persist this turn");
    expect(receivedSystemPrompt).toContain(
      "You are Sandbox Test Agent, an AI agent.",
    );
    expect(receivedSystemPrompt).toContain("exact immutable Pi append prompt");
    expect(receivedDatabasePath).toBe(CANONICAL_PI_SESSION_DATABASE_PATH);
    expect(io.outputs).toEqual([
      { type: "system", subtype: "init", session_id: SESSION_ID },
      {
        type: "assistant",
        message: {
          id: "response-1",
          role: "assistant",
          content: [{ type: "text", text: "Sandbox answer." }],
          model: "deepseek-v4-flash",
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Sandbox answer.",
        session_id: SESSION_ID,
        duration_ms: expect.any(Number),
      },
    ]);
  });

  it("returns a terminal error frame for a failed model turn", async () => {
    const io = new FakeIo([
      { type: "user", message: { role: "user", content: "fail" } },
    ]);
    const executionEnv = await createPiNodeExecutionEnv();
    const finalMessage = {
      ...assistantMessage([], "error"),
      errorMessage: "provider failed",
    };
    const runSession: typeof runPiAgentSession = async () => {
      return {
        messages: [finalMessage],
        finalAssistantMessage: finalMessage,
      };
    };

    try {
      await expect(
        runPiSandboxAgentLoop(
          { io, config: CONFIG, executionEnv, runSession },
          new AbortController().signal,
        ),
      ).resolves.toBe(1);
    } finally {
      await executionEnv.cleanup();
    }

    expect(io.outputs.at(-1)).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "provider failed",
      session_id: SESSION_ID,
    });
  });
});
