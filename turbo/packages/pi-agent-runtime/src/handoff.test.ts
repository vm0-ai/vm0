import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

import { createPiNodeExecutionEnv } from "./node";
import { executePiHandoffToolBatch, piHandoffToolBatch } from "./handoff";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  id: string,
  toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>,
): AssistantMessage {
  return {
    role: "assistant",
    content: toolCalls.map((toolCall) => {
      return { type: "toolCall" as const, ...toolCall };
    }),
    api: "openai-completions",
    provider: "deepseek",
    model: id,
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(toolCallId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "already complete" }],
    details: {},
    isError: false,
    timestamp: 2,
  };
}

describe("Pi handoff boundary", () => {
  it("selects every tool call from the final assistant boundary", () => {
    const first = assistant("first", [
      { id: "read-1", name: "read", arguments: { path: "/first" } },
    ]);
    const second = assistant("second", [
      { id: "read-2", name: "read", arguments: { path: "/second" } },
      { id: "write-2", name: "write", arguments: { path: "/out" } },
    ]);
    const messages: Message[] = [first, toolResult("read-1"), second];

    const batch = piHandoffToolBatch(messages);

    expect(batch.assistant).toBe(second);
    expect(
      batch.toolCalls.map(({ id }) => {
        return id;
      }),
    ).toEqual(["read-2", "write-2"]);
  });

  it("executes a pending read through the Node ExecutionEnv", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pi-handoff-"));
    const file = join(root, "skill", "references", "answer.txt");
    await mkdir(join(root, "skill", "references"), { recursive: true });
    await writeFile(file, "sandbox snapshot bytes\n");
    const env = createPiNodeExecutionEnv({ cwd: root });
    const messages: Message[] = [
      assistant("handoff", [
        {
          id: "read-snapshot",
          name: "read",
          arguments: { path: file },
        },
      ]),
    ];
    let completedMessages = 0;

    try {
      const results = await executePiHandoffToolBatch(
        {
          messages,
          executionEnv: env,
          onEvent(event) {
            if (event.type === "message_end") {
              completedMessages += 1;
            }
          },
        },
        context.signal,
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        role: "toolResult",
        toolCallId: "read-snapshot",
        toolName: "read",
        content: [{ type: "text", text: "sandbox snapshot bytes\n" }],
        isError: false,
      });
      expect(completedMessages).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an error ToolResult for an unavailable tool", async (context) => {
    const env = createPiNodeExecutionEnv({ cwd: tmpdir() });
    const results = await executePiHandoffToolBatch(
      {
        messages: [
          assistant("handoff", [
            { id: "unknown-1", name: "unknown", arguments: {} },
          ]),
        ],
        executionEnv: env,
        onEvent() {},
      },
      context.signal,
    );

    expect(results[0]).toMatchObject({
      toolCallId: "unknown-1",
      isError: true,
      content: [{ type: "text", text: "Tool unknown not found" }],
    });
  });
});
