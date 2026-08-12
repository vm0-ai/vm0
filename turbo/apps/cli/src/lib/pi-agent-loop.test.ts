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

const PRIOR_ASSISTANT = assistantMessage(
  [{ type: "text", text: "Previous answer." }],
  "stop",
);

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

function persistedMessage(
  ordinal: number,
  sequenceNumber: number,
  payload: PiAgentMessage,
  runId = CONFIG.runId,
) {
  return {
    ordinal,
    messageId: `${runId}/${sequenceNumber}`,
    runId,
    runEventSequenceNumber: sequenceNumber,
    role: payload.role,
    payload,
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}

function transcriptPage(
  messages: ReturnType<typeof persistedMessage>[],
  hasMore = false,
) {
  return {
    lastOrdinal: messages.at(-1)?.ordinal ?? 0,
    hasMore,
    messages,
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

class ControlledIo implements PiAgentLoopIo {
  readonly outputs: Array<Record<string, unknown>> = [];
  readonly #inputs: unknown[] = [];
  readonly #readers: Array<(frame: unknown) => void> = [];
  readonly #onWrite: (
    frame: Readonly<Record<string, unknown>>,
    io: ControlledIo,
  ) => void;

  constructor(
    onWrite: (
      frame: Readonly<Record<string, unknown>>,
      io: ControlledIo,
    ) => void,
  ) {
    this.#onWrite = onWrite;
  }

  push(frame: unknown): void {
    const reader = this.#readers.shift();
    if (reader === undefined) {
      this.#inputs.push(frame);
      return;
    }
    reader(frame);
  }

  async read(): Promise<unknown | null> {
    const frame = this.#inputs.shift();
    if (frame !== undefined) {
      return frame;
    }
    return await new Promise<unknown>((resolve) => {
      this.#readers.push(resolve);
    });
  }

  async write(frame: Readonly<Record<string, unknown>>): Promise<void> {
    this.outputs.push({ ...frame });
    this.#onWrite(frame, this);
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

  it("starts reading immediately and honors an API release", async () => {
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

    expect(resumed).toBeFalsy();
    expect(io.outputs[1]).toEqual({
      type: "pi-transcript-read",
      requestId: "transcript-1",
      afterOrdinal: 0,
    });
    expect(io.outputs.at(-1)).toEqual({
      type: "pi-released",
      reason: "api-complete",
    });
  });

  it("fails when no tool call is persisted before the standby TTL", async () => {
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

    try {
      await expect(
        runPiStandbyAgentLoop(
          {
            io,
            config: CONFIG,
            executionEnv,
            standbyTtlSeconds: 0.01,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("timed out waiting for a persisted tool call");
    } finally {
      await executionEnv.cleanup();
    }

    expect(io.outputs).not.toContainEqual({
      type: "pi-released",
      reason: "ttl",
    });
  });

  it("takes over from the database without handoff and ignores later controls", async () => {
    const io = new FakeIo([
      {
        type: "pi-transcript",
        requestId: "transcript-1",
        transcript: transcriptPage([persistedMessage(1, 0, HANDOFF_ASSISTANT)]),
      },
      { type: "pi-handoff" },
      {
        type: "pi-message-ack",
        messageId: `${CONFIG.runId}/1`,
        status: 200,
      },
      { type: "pi-standby-release", reason: "api-complete" },
      {
        type: "pi-message-ack",
        messageId: `${CONFIG.runId}/2`,
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
      sequenceNumber: 1,
      messageId: `${CONFIG.runId}/1`,
    });
    expect(eventMessage(messageFrames[0]!)).toEqual(TOOL_RESULT);
    expect(messageFrames[1]?.event).toMatchObject({
      sequenceNumber: 2,
      messageId: `${CONFIG.runId}/2`,
    });
    expect(eventMessage(messageFrames[1]!)).toEqual(FINAL_ASSISTANT);
    expect(io.outputs.at(-1)).toMatchObject({
      type: "pi-complete",
      exitCode: 0,
      lastEventSequence: 2,
      skillSnapshotDigest: SNAPSHOT_DIGEST,
    });
  });

  it("drains transcript pages before taking over", async () => {
    const io = new FakeIo([
      {
        type: "pi-transcript",
        requestId: "transcript-1",
        transcript: transcriptPage(
          [persistedMessage(1, 6, PRIOR_ASSISTANT)],
          true,
        ),
      },
      {
        type: "pi-transcript",
        requestId: "transcript-2",
        transcript: transcriptPage([persistedMessage(2, 7, HANDOFF_ASSISTANT)]),
      },
    ]);
    const executionEnv = createPiNodeExecutionEnv({ cwd: tmpdir() });
    let resumedMessages: readonly PiAgentMessage[] = [];
    const resume = (async (args) => {
      resumedMessages = args.messages;
    }) satisfies PiAgentResume;

    try {
      await runPiStandbyAgentLoop(
        { io, config: CONFIG, executionEnv, standbyTtlSeconds: 1, resume },
        new AbortController().signal,
      );
    } finally {
      await executionEnv.cleanup();
    }

    expect(resumedMessages).toEqual([PRIOR_ASSISTANT, HANDOFF_ASSISTANT]);
    expect(io.outputs[2]).toEqual({
      type: "pi-transcript-read",
      requestId: "transcript-2",
      afterOrdinal: 1,
    });
  });

  it("polls again when the handoff notification is missed", async () => {
    let transcriptReads = 0;
    const io = new ControlledIo((frame, controlled) => {
      if (frame.type === "pi-transcript-read") {
        transcriptReads += 1;
        controlled.push({
          type: "pi-transcript",
          requestId: frame.requestId,
          transcript:
            transcriptReads === 1
              ? transcriptPage([])
              : transcriptPage([persistedMessage(1, 7, HANDOFF_ASSISTANT)]),
        });
      }
    });
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
          pollIntervalMs: 1,
          resume,
        },
        new AbortController().signal,
      );
    } finally {
      await executionEnv.cleanup();
    }

    expect(transcriptReads).toBe(2);
    expect(resumed).toBeTruthy();
  });

  it("does not take over a tool call from a previous run", async () => {
    const previousRunId = "00000000-0000-4000-8000-000000000122";
    let transcriptReads = 0;
    const io = new ControlledIo((frame, controlled) => {
      if (frame.type !== "pi-transcript-read") {
        return;
      }
      transcriptReads += 1;
      controlled.push({
        type: "pi-transcript",
        requestId: frame.requestId,
        transcript:
          transcriptReads === 1
            ? transcriptPage([
                persistedMessage(1, 7, HANDOFF_ASSISTANT, previousRunId),
              ])
            : transcriptPage([persistedMessage(2, 1, HANDOFF_ASSISTANT)]),
      });
    });
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
          pollIntervalMs: 1,
          resume,
        },
        new AbortController().signal,
      );
    } finally {
      await executionEnv.cleanup();
    }

    expect(transcriptReads).toBe(2);
    expect(resumed).toBeTruthy();
  });
});
