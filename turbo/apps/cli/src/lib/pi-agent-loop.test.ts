import { CANONICAL_PI_SESSION_DATABASE_PATH } from "@vm0/api-contracts/contracts/runners";
import {
  runPiAgentSession,
  type PiAssistantMessage,
} from "@vm0/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";

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
  systemPrompt: "exact immutable Pi system prompt",
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-v4-flash",
    apiKey: "test-api-key",
  },
  databasePath: CANONICAL_PI_SESSION_DATABASE_PATH,
};

function piEnv(runIdEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...runIdEnv,
    OKOU_PI_SESSION_ID: SESSION_ID,
    OKOU_PI_SYSTEM_PROMPT: CONFIG.systemPrompt,
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
  it("accepts the legacy VM0 run id from an old guest", () => {
    expect(
      piSandboxAgentConfigFromEnv(
        piEnv({
          VM0_RUN_ID: RUN_ID,
        }),
      ),
    ).toEqual(CONFIG);
  });

  it("accepts the canonical OKOU run id from a new guest", () => {
    expect(
      piSandboxAgentConfigFromEnv(
        piEnv({
          OKOU_RUN_ID: RUN_ID,
        }),
      ),
    ).toEqual(CONFIG);
  });

  it("accepts equal canonical and legacy run ids from a new guest", () => {
    expect(
      piSandboxAgentConfigFromEnv(
        piEnv({
          OKOU_RUN_ID: RUN_ID,
          VM0_RUN_ID: RUN_ID,
        }),
      ),
    ).toEqual(CONFIG);
  });

  it("fails closed without exposing mismatched run ids", () => {
    const canonicalRunId = "canonical-sensitive-run-id";
    const legacyRunId = "legacy-sensitive-run-id";

    expect(() => {
      return piSandboxAgentConfigFromEnv(
        piEnv({
          OKOU_RUN_ID: canonicalRunId,
          VM0_RUN_ID: legacyRunId,
        }),
      );
    }).toThrowError("Pi run identity environment mismatch");
    try {
      piSandboxAgentConfigFromEnv(
        piEnv({
          OKOU_RUN_ID: canonicalRunId,
          VM0_RUN_ID: legacyRunId,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(canonicalRunId);
      expect(message).not.toContain(legacyRunId);
    }
  });

  it("uses the canonical name when the run id is missing", () => {
    expect(() => {
      return piSandboxAgentConfigFromEnv(piEnv({}));
    }).toThrowError("OKOU_RUN_ID is required for Pi execution");
  });

  it("names the canonical variable without exposing invalid model config", () => {
    const invalidModelConfig = "credential-like-model-config{";
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    env.OKOU_PI_MODEL_CONFIG = invalidModelConfig;

    expect(() => {
      return piSandboxAgentConfigFromEnv(env);
    }).toThrowError("OKOU_PI_MODEL_CONFIG must contain valid JSON");
    try {
      piSandboxAgentConfigFromEnv(env);
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
    let receivedDatabasePath: string | undefined;
    const runSession: typeof runPiAgentSession = async (args) => {
      receivedPrompt = args.prompt;
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
