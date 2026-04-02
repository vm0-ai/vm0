import { describe, expect, it } from "vitest";
import { parseInspectLogCsv } from "../inspect-log-parser.ts";

function buildCsvWithMeta(
  meta: Record<string, unknown>,
  rows: string[],
): string {
  const metaLine = `# __vm0_meta__:${JSON.stringify(meta)}`;
  const header = "sequenceNumber,eventType,eventData,createdAt";
  return [metaLine, header, ...rows].join("\n");
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildRow(
  seq: number,
  type: string,
  data: unknown,
  createdAt: string,
): string {
  return [
    String(seq),
    escapeCsvField(type),
    escapeCsvField(JSON.stringify(data)),
    escapeCsvField(createdAt),
  ].join(",");
}

const systemEvent = buildRow(
  1,
  "system",
  { subtype: "init" },
  "2026-04-01T00:00:00.000Z",
);

const assistantEvent = buildRow(
  1,
  "assistant",
  { message: "hello" },
  "2026-04-01T00:00:01.000Z",
);

describe("parseInspectLogCsv", () => {
  it("parses new-format CSV with metadata line", () => {
    const meta = {
      id: "abc-123",
      displayName: "Test Agent",
      status: "completed",
      triggerSource: "web",
    };
    const csv = buildCsvWithMeta(meta, [systemEvent]);

    const result = parseInspectLogCsv(csv);

    expect(result.meta).toStrictEqual(meta);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({
      sequenceNumber: 1,
      eventType: "system",
      eventData: { subtype: "init" },
      createdAt: "2026-04-01T00:00:00.000Z",
    });
  });

  it("parses old-format CSV without metadata line", () => {
    const header = "sequenceNumber,eventType,eventData,createdAt";
    const csv = [header, assistantEvent].join("\n");

    const result = parseInspectLogCsv(csv);

    expect(result.meta).toBeNull();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({
      sequenceNumber: 1,
      eventType: "assistant",
      eventData: { message: "hello" },
      createdAt: "2026-04-01T00:00:01.000Z",
    });
  });

  it("handles eventData JSON with commas, quotes, and newlines", () => {
    const complexData = {
      message: {
        content: [
          { type: "text", text: 'He said, "hello"\nand then left' },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "echo 'a,b,c'" },
          },
        ],
      },
    };
    const row = buildRow(
      2,
      "assistant",
      complexData,
      "2026-04-01T00:00:02.000Z",
    );
    const header = "sequenceNumber,eventType,eventData,createdAt";
    const csv = [header, row].join("\n");

    const result = parseInspectLogCsv(csv);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventData).toStrictEqual(complexData);
  });

  it("returns empty events for empty CSV", () => {
    const result = parseInspectLogCsv("");

    expect(result.meta).toBeNull();
    expect(result.events).toHaveLength(0);
  });

  it("preserves all LogDetail fields in metadata", () => {
    const fullMeta = {
      id: "abc-123",
      displayName: "My Agent",
      status: "failed",
      triggerSource: "cli",
      triggerAgentName: "parent-agent",
      modelProvider: "anthropic",
      selectedModel: "claude-sonnet-4-6",
      framework: "claude-code",
      prompt: "Do something",
      appendSystemPrompt: "Be helpful",
      error: "timeout exceeded",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:01.000Z",
      completedAt: "2026-04-01T00:05:00.000Z",
      agentId: "agent-1",
      sessionId: "session-1",
      scheduleId: "schedule-1",
    };
    const csv = buildCsvWithMeta(fullMeta, []);

    const result = parseInspectLogCsv(csv);

    expect(result.meta).toStrictEqual(fullMeta);
    expect(result.events).toHaveLength(0);
  });
});
