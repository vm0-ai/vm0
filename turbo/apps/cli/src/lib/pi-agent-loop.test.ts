import { tmpdir } from "node:os";

import {
  PI_SKILLS_ROOT,
  type RunSkillSnapshot,
} from "@vm0/api-contracts/contracts/runners";
import {
  createPiNodeExecutionEnv,
  type PiAgentMessage,
} from "@vm0/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";

import {
  piStandbyAgentConfigFromEnv,
  runPiStandbyAgentLoop,
  type PiAgentLoopIo,
  type PiAgentResume,
  type PiStandbyAgentConfig,
} from "./pi-agent-loop";

type AssistantMessage = Extract<PiAgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<PiAgentMessage, { role: "toolResult" }>;

const SNAPSHOT_DIGEST = `sha256:${"1".repeat(64)}`;
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: 1,
  };
}

const HANDOFF_ASSISTANT = assistantMessage([
  {
    type: "toolCall",
    id: "bash-1",
    name: "bash",
    arguments: { command: "pwd" },
  },
]);

const TOOL_RESULT: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "bash-1",
  toolName: "bash",
  content: [{ type: "text", text: "/home/user/workspace\n" }],
  details: {},
  isError: false,
  timestamp: 2,
};

const FINAL_ASSISTANT = assistantMessage(
  [{ type: "text", text: "Sandbox handoff complete." }],
  "stop",
);

const SNAPSHOT: RunSkillSnapshot = {
  schemaVersion: 1,
  policyVersion: 1,
  root: PI_SKILLS_ROOT,
  digest: SNAPSHOT_DIGEST,
  entries: [],
};

const CONFIG: PiStandbyAgentConfig = {
  runId: "00000000-0000-4000-8000-000000000123",
  systemPrompt: "exact immutable Pi system prompt",
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-chat",
    apiKey: "test-api-key",
  },
  skillSnapshot: SNAPSHOT,
};

function transcript(lastOrdinal = 3) {
  return {
    version: 1,
    lastOrdinal,
    messages: [
      {
        ordinal: 3,
        messageId: `${CONFIG.runId}/7`,
        runId: CONFIG.runId,
        runEventSequenceNumber: 7,
        role: "assistant",
        payload: HANDOFF_ASSISTANT,
        createdAt: "2026-08-06T00:00:00.000Z",
      },
    ],
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

function eventMessage(frame: Record<string, unknown>): PiAgentMessage {
  return (frame.event as { message: PiAgentMessage }).message;
}

describe("internal Pi standby agent loop", () => {
  it("keeps the injected prompt and snapshot exact", () => {
    const config = piStandbyAgentConfigFromEnv({
      VM0_RUN_ID: CONFIG.runId,
      VM0_PI_SYSTEM_PROMPT: CONFIG.systemPrompt,
      VM0_PI_MODEL_CONFIG: JSON.stringify({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/",
        model: "deepseek-chat",
        apiKeyEnv: "OPENAI_API_KEY",
      }),
      VM0_RUN_SKILL_SNAPSHOT: JSON.stringify(SNAPSHOT),
      OPENAI_API_KEY: "test-api-key",
    });

    expect(config).toEqual(CONFIG);
    expect(config.systemPrompt).toBe(CONFIG.systemPrompt);
    expect(config.skillSnapshot).toEqual(SNAPSHOT);
  });

  it("releases an unused standby without starting the model", async () => {
    const io = new FakeIo([
      { type: "pi-standby-release", reason: "api-complete" },
    ]);
    const executionEnv = createPiNodeExecutionEnv({ cwd: tmpdir() });
    let resumed = false;
    const resume = (async () => {
      resumed = true;
    }) satisfies PiAgentResume;

    try {
      await runPiStandbyAgentLoop(
        {
          io,
          config: CONFIG,
          executionEnv,
          standbyTtlSeconds: 1,
          resume,
        },
        new AbortController().signal,
      );
    } finally {
      await executionEnv.cleanup();
    }

    expect(resumed).toBe(false);
    expect(io.outputs[0]).toMatchObject({
      type: "pi-ready",
      runId: CONFIG.runId,
      skillSnapshotDigest: SNAPSHOT_DIGEST,
    });
    expect(io.outputs.at(-1)).toEqual({
      type: "pi-released",
      reason: "api-complete",
    });
  });

  it("releases itself when the standby TTL expires with no control frame", async () => {
    // A prewarmed standby waits with its control stream open and no frame
    // pending. FakeIo cannot express that: an empty queue resolves `read()`
    // with null, which makes `readFrame` throw before the TTL timer can win
    // the race. This IO keeps the read pending so the TTL path is reachable.
    class SilentIo implements PiAgentLoopIo {
      readonly outputs: Array<Record<string, unknown>> = [];

      async read(): Promise<unknown | null> {
        return await new Promise<never>(() => {});
      }

      async write(frame: Readonly<Record<string, unknown>>): Promise<void> {
        this.outputs.push({ ...frame });
      }
    }

    const io = new SilentIo();
    const executionEnv = createPiNodeExecutionEnv({ cwd: tmpdir() });
    let resumed = false;
    const resume = (async () => {
      resumed = true;
    }) satisfies PiAgentResume;

    try {
      await runPiStandbyAgentLoop(
        {
          io,
          config: CONFIG,
          executionEnv,
          standbyTtlSeconds: 0.05,
          resume,
        },
        new AbortController().signal,
      );
    } finally {
      await executionEnv.cleanup();
    }

    expect(resumed).toBe(false);
    expect(io.outputs.at(-1)).toEqual({ type: "pi-released", reason: "ttl" });
  });

  it("acks every message before reporting completion", async () => {
    const io = new FakeIo([
      { type: "pi-handoff" },
      {
        type: "pi-transcript",
        requestId: "transcript-1",
        transcript: transcript(),
      },
      {
        type: "pi-message-ack",
        messageId: `${CONFIG.runId}/8`,
        status: 200,
      },
      {
        type: "pi-message-ack",
        messageId: `${CONFIG.runId}/9`,
        status: 200,
      },
    ]);
    const executionEnv = createPiNodeExecutionEnv({ cwd: tmpdir() });
    const resume = (async (args) => {
      expect(args.systemPrompt).toBe(CONFIG.systemPrompt);
      await args.onMessage(TOOL_RESULT);
      await args.onMessage(FINAL_ASSISTANT);
    }) satisfies PiAgentResume;

    try {
      await runPiStandbyAgentLoop(
        {
          io,
          config: CONFIG,
          executionEnv,
          standbyTtlSeconds: 1,
          resume,
        },
        new AbortController().signal,
      );
    } finally {
      await executionEnv.cleanup();
    }

    const messageFrames = io.outputs.filter((frame) => {
      return frame.type === "pi-message";
    });
    expect(messageFrames).toHaveLength(2);
    expect(messageFrames[0]?.event).toMatchObject({
      type: "pi.message.completed",
      sequenceNumber: 8,
      messageId: `${CONFIG.runId}/8`,
      expectedVersion: 1,
      expectedLastOrdinal: 3,
    });
    expect(eventMessage(messageFrames[0]!)).toEqual(TOOL_RESULT);
    expect(messageFrames[1]?.event).toMatchObject({
      sequenceNumber: 9,
      messageId: `${CONFIG.runId}/9`,
      expectedLastOrdinal: 4,
    });
    expect(eventMessage(messageFrames[1]!)).toEqual(FINAL_ASSISTANT);
    expect(io.outputs.at(-1)).toMatchObject({
      type: "pi-complete",
      exitCode: 0,
      lastEventSequence: 9,
      skillSnapshotDigest: SNAPSHOT_DIGEST,
    });
  });

  it("re-reads and replays after a CAS conflict", async () => {
    const io = new FakeIo([
      { type: "pi-handoff" },
      {
        type: "pi-transcript",
        requestId: "transcript-1",
        transcript: transcript(3),
      },
      {
        type: "pi-message-ack",
        messageId: `${CONFIG.runId}/8`,
        status: 409,
      },
      {
        type: "pi-transcript",
        requestId: "transcript-2",
        transcript: transcript(4),
      },
      {
        type: "pi-message-ack",
        messageId: `${CONFIG.runId}/8`,
        status: 200,
      },
    ]);
    const executionEnv = createPiNodeExecutionEnv({ cwd: tmpdir() });
    let resumeCount = 0;
    const resume = (async (args) => {
      resumeCount += 1;
      await args.onMessage(TOOL_RESULT);
    }) satisfies PiAgentResume;

    try {
      await runPiStandbyAgentLoop(
        {
          io,
          config: CONFIG,
          executionEnv,
          standbyTtlSeconds: 1,
          resume,
        },
        new AbortController().signal,
      );
    } finally {
      await executionEnv.cleanup();
    }

    expect(resumeCount).toBe(2);
    expect(
      io.outputs.filter((frame) => {
        return frame.type === "pi-transcript-read";
      }),
    ).toHaveLength(2);
    expect(io.outputs).toContainEqual({ type: "pi-transcript-conflict" });
    const messageFrames = io.outputs.filter((frame) => {
      return frame.type === "pi-message";
    });
    expect(messageFrames).toHaveLength(2);
    expect(messageFrames[0]?.event).toMatchObject({
      messageId: `${CONFIG.runId}/8`,
      expectedLastOrdinal: 3,
    });
    expect(messageFrames[1]?.event).toMatchObject({
      messageId: `${CONFIG.runId}/8`,
      expectedLastOrdinal: 4,
    });
    expect(io.outputs.at(-1)).toMatchObject({
      type: "pi-complete",
      lastEventSequence: 8,
    });
  });
});
