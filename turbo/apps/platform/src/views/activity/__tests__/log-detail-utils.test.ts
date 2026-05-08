import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";
import { groupEventsIntoMessages } from "../../zero-page/components/log-views/log-detail-utils.ts";

const createdAt = "2026-05-08T08:00:00.000Z";

function codexEvent(sequenceNumber: number, eventData: unknown): AgentEvent {
  const eventType =
    typeof eventData === "object" &&
    eventData !== null &&
    "type" in eventData &&
    typeof eventData.type === "string"
      ? eventData.type
      : "unknown";

  return {
    sequenceNumber,
    eventType,
    eventData,
    createdAt,
  };
}

describe("log detail event grouping", () => {
  it("groups Codex JSONL events into visible timeline messages", () => {
    const messages = groupEventsIntoMessages([
      codexEvent(1, {
        type: "thread.started",
        thread_id: "00000000-0000-0000-0000-000000000001",
      }),
      codexEvent(2, {
        type: "item.started",
        item: {
          id: "item-cmd-1",
          type: "command_execution",
          status: "in_progress",
          command: "echo hello",
        },
      }),
      codexEvent(3, {
        type: "item.completed",
        item: {
          id: "item-cmd-1",
          type: "command_execution",
          status: "completed",
          command: "echo hello",
          exit_code: 0,
          aggregated_output: "hello\n",
        },
      }),
      codexEvent(4, {
        type: "item.started",
        item: {
          id: "item-edit-1",
          type: "file_edit",
          status: "in_progress",
          path: "/tmp/edit-target.txt",
        },
      }),
      codexEvent(5, {
        type: "item.completed",
        item: {
          id: "item-edit-1",
          type: "file_edit",
          status: "completed",
          path: "/tmp/edit-target.txt",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
      }),
      codexEvent(6, {
        type: "item.started",
        item: {
          id: "item-read-1",
          type: "file_read",
          status: "in_progress",
          path: "/tmp/read-target.txt",
        },
      }),
      codexEvent(7, {
        type: "item.completed",
        item: {
          id: "item-read-1",
          type: "file_read",
          status: "completed",
          path: "/tmp/read-target.txt",
        },
      }),
      codexEvent(8, {
        type: "item.completed",
        item: {
          id: "item-change-1",
          type: "file_change",
          changes: [
            { kind: "add", path: "/tmp/created.txt" },
            { kind: "modify", path: "/tmp/modified.txt" },
            { kind: "delete", path: "/tmp/removed.txt" },
          ],
        },
      }),
      codexEvent(9, {
        type: "item.completed",
        item: {
          id: "item-think-1",
          type: "reasoning",
          text: "Considering the request before acting",
        },
      }),
      codexEvent(10, {
        type: "item.completed",
        item: {
          id: "item-msg-1",
          type: "agent_message",
          text: "Fixture event walkthrough complete",
        },
      }),
      codexEvent(11, {
        type: "turn.completed",
        usage: {
          input_tokens: 50,
          cached_input_tokens: 25,
          output_tokens: 100,
          reasoning_output_tokens: 10,
        },
      }),
    ]);

    expect(
      messages.map((message) => {
        return message.type;
      }),
    ).toStrictEqual([
      "system",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "result",
    ]);

    const toolMessage = messages[1];
    expect(
      toolMessage.toolOperations?.map((operation) => {
        return operation.toolName;
      }),
    ).toStrictEqual(["Bash", "Edit", "Read"]);
    expect(toolMessage.toolOperations?.[0]?.result).toMatchObject({
      content: "hello\n",
      isError: false,
    });
    expect(toolMessage.toolOperations?.[1]?.result?.content).toContain("+new");
    expect(toolMessage.toolOperations?.[2]?.result?.content).toBe(
      "File read completed",
    );

    expect(messages[2].textBefore).toContain("Files changed");
    expect(messages[2].textBefore).toContain("modify /tmp/modified.txt");
    expect(messages[3].textBefore).toBe(
      "[thinking] Considering the request before acting",
    );
    expect(messages[4].textBefore).toBe("Fixture event walkthrough complete");

    const resultData = messages[5].eventData as {
      result?: string;
      modelUsage?: { codex?: { inputTokens?: number; outputTokens?: number } };
      codex_usage?: {
        cached_input_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
    expect(resultData.result).toBe("");
    expect(resultData.modelUsage?.codex).toMatchObject({
      inputTokens: 50,
      outputTokens: 100,
    });
    expect(resultData.codex_usage).toMatchObject({
      cached_input_tokens: 25,
      reasoning_output_tokens: 10,
    });
  });

  it("renders Codex turn failure and top-level error events as failed results", () => {
    const messages = groupEventsIntoMessages([
      codexEvent(1, {
        type: "thread.started",
        thread_id: "00000000-0000-0000-0000-000000000002",
      }),
      codexEvent(2, {
        type: "item.completed",
        item: {
          id: "item-msg-2",
          type: "agent_message",
          text: "Attempting the turn",
        },
      }),
      codexEvent(3, {
        type: "turn.failed",
        error: "Mock turn failure for fixture testing",
      }),
      codexEvent(4, {
        type: "error",
        message: "Mock error event for fixture testing",
      }),
    ]);

    expect(
      messages.map((message) => {
        return message.type;
      }),
    ).toStrictEqual(["system", "assistant", "result", "result"]);
    expect(messages[1].textBefore).toBe("Attempting the turn");
    expect(messages[2].eventData).toMatchObject({
      is_error: true,
      result: "Mock turn failure for fixture testing",
    });
    expect(messages[3].eventData).toMatchObject({
      is_error: true,
      result: "Mock error event for fixture testing",
    });
  });

  it("renders unknown Codex item types with a visible fallback", () => {
    const messages = groupEventsIntoMessages([
      codexEvent(1, {
        type: "item.completed",
        item: {
          id: "item-web-1",
          type: "web_search",
          status: "completed",
          query: "codex event schema",
        },
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "assistant",
      textBefore:
        "Codex web_search (item.completed, status: completed, id: item-web-1)\ncodex event schema",
    });
  });

  it("renders unhandled Codex item lifecycle events with a visible fallback", () => {
    const messages = groupEventsIntoMessages([
      codexEvent(1, {
        type: "item.updated",
        item: {
          id: "item-cmd-2",
          type: "command_execution",
          status: "in_progress",
          output: "partial output",
        },
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "assistant",
      textBefore:
        "Codex command_execution (item.updated, status: in_progress, id: item-cmd-2)\npartial output",
    });
  });

  it("keeps Claude-shaped events on the existing grouping path", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Claude response text" }],
          },
        },
        createdAt,
      },
      {
        sequenceNumber: 2,
        eventType: "result",
        eventData: {
          result: "Claude result text",
          is_error: false,
          num_turns: 1,
        },
        createdAt,
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "assistant",
      textBefore: "Claude response text",
    });
    expect(messages[1]).toMatchObject({
      type: "result",
      eventData: { result: "Claude result text" },
    });
  });
});
