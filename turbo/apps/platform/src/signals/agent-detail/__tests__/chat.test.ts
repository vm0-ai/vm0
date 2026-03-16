import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../../logs-page/types.ts";
import { extractKeyParam, extractStreamingState } from "../chat.ts";

describe("extractKeyParam", () => {
  it("should extract truncated command for bash tool", () => {
    const cmd = "a".repeat(80);
    expect(extractKeyParam("Bash", { command: cmd })).toBe(
      `${"a".repeat(57)}...`,
    );
  });

  it("should return full command when under 60 chars", () => {
    expect(extractKeyParam("bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("should extract url for webfetch", () => {
    expect(extractKeyParam("WebFetch", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
  });

  it("should extract query for websearch", () => {
    expect(extractKeyParam("WebSearch", { query: "test query" })).toBe(
      "test query",
    );
  });

  it("should prefer url over query for webfetch", () => {
    expect(
      extractKeyParam("WebFetch", {
        url: "https://example.com",
        query: "fallback",
      }),
    ).toBe("https://example.com");
  });

  it("should extract file_path for read tool", () => {
    expect(extractKeyParam("Read", { file_path: "/tmp/test.ts" })).toBe(
      "/tmp/test.ts",
    );
  });

  it("should extract path for write tool", () => {
    expect(extractKeyParam("Write", { path: "/tmp/out.ts" })).toBe(
      "/tmp/out.ts",
    );
  });

  it("should extract pattern for grep tool", () => {
    expect(extractKeyParam("Grep", { pattern: "*.ts" })).toBe("*.ts");
  });

  it("should extract skill name for skill tool", () => {
    expect(extractKeyParam("Skill", { skill: "code-quality" })).toBe(
      "code-quality",
    );
  });

  it("should return empty string for unknown tool", () => {
    expect(extractKeyParam("UnknownTool", { foo: "bar" })).toBe("");
  });

  it("should return empty string when expected param is missing", () => {
    expect(extractKeyParam("bash", {})).toBe("");
  });
});

describe("extractStreamingState", () => {
  function makeEvent(
    seq: number,
    eventType: string,
    eventData: unknown,
  ): AgentEvent {
    return {
      sequenceNumber: seq,
      eventType,
      eventData,
      createdAt: new Date().toISOString(),
    };
  }

  it("should return empty state for no events", () => {
    expect(extractStreamingState([])).toStrictEqual({
      latestText: "",
      toolUses: [],
    });
  });

  it("should detect system init as tool indicator", () => {
    const events = [makeEvent(1, "system", { subtype: "init" })];
    expect(extractStreamingState(events)).toStrictEqual({
      latestText: "",
      toolUses: [{ name: "Initialize", keyParam: "" }],
    });
  });

  it("should extract text from assistant message", () => {
    const events = [
      makeEvent(1, "assistant", {
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      }),
    ];
    expect(extractStreamingState(events)).toStrictEqual({
      latestText: "Hello world",
      toolUses: [],
    });
  });

  it("should extract tool use from assistant message", () => {
    const events = [
      makeEvent(1, "assistant", {
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    ];
    expect(extractStreamingState(events)).toStrictEqual({
      latestText: "",
      toolUses: [{ name: "Bash", keyParam: "ls" }],
    });
  });

  it("should clear tool uses when new text arrives", () => {
    const events = [
      makeEvent(1, "assistant", {
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      makeEvent(2, "assistant", {
        message: {
          content: [{ type: "text", text: "Result text" }],
        },
      }),
    ];
    expect(extractStreamingState(events)).toStrictEqual({
      latestText: "Result text",
      toolUses: [],
    });
  });

  it("should accumulate tool uses after text", () => {
    const events = [
      makeEvent(1, "assistant", {
        message: {
          content: [{ type: "text", text: "Let me check" }],
        },
      }),
      makeEvent(2, "assistant", {
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
          ],
        },
      }),
      makeEvent(3, "assistant", {
        message: {
          content: [
            { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
          ],
        },
      }),
    ];
    const result = extractStreamingState(events);
    expect(result.latestText).toBe("Let me check");
    expect(result.toolUses).toHaveLength(2);
    expect(result.toolUses[0]).toStrictEqual({
      name: "Read",
      keyParam: "/a.ts",
    });
    expect(result.toolUses[1]).toStrictEqual({ name: "Grep", keyParam: "foo" });
  });

  it("should skip non-system non-assistant events", () => {
    const events = [
      makeEvent(1, "user", { message: "hello" }),
      makeEvent(2, "result", { result: "done" }),
    ];
    expect(extractStreamingState(events)).toStrictEqual({
      latestText: "",
      toolUses: [],
    });
  });

  it("should handle null content gracefully", () => {
    const events = [makeEvent(1, "assistant", { message: { content: null } })];
    expect(extractStreamingState(events)).toStrictEqual({
      latestText: "",
      toolUses: [],
    });
  });

  it("should skip events with non-object eventData", () => {
    const events = [
      makeEvent(1, "assistant", "not-an-object"),
      makeEvent(2, "assistant", null),
      makeEvent(3, "assistant", 42),
    ];
    expect(extractStreamingState(events)).toStrictEqual({
      latestText: "",
      toolUses: [],
    });
  });
});
