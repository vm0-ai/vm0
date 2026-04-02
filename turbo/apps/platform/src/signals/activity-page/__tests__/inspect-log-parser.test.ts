import { describe, expect, it } from "vitest";
import { parseInspectLog } from "../inspect-log-parser.ts";

describe("parseInspectLog", () => {
  it("parses JSON with meta and events", () => {
    const input = {
      meta: {
        id: "abc-123",
        displayName: "Test Agent",
        status: "completed",
        triggerSource: "web",
      },
      events: [
        {
          sequenceNumber: 1,
          eventType: "system",
          eventData: { subtype: "init" },
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    };

    const result = parseInspectLog(JSON.stringify(input));

    expect(result.meta).toStrictEqual(input.meta);
    expect(result.context).toBeNull();
    expect(result.networkLogs).toBeNull();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual(input.events[0]);
  });

  it("returns defaults for empty object", () => {
    const result = parseInspectLog("{}");

    expect(result.meta).toBeNull();
    expect(result.context).toBeNull();
    expect(result.networkLogs).toBeNull();
    expect(result.events).toHaveLength(0);
  });

  it("preserves all LogDetail fields in meta", () => {
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
    const result = parseInspectLog(JSON.stringify({ meta: fullMeta }));

    expect(result.meta).toStrictEqual(fullMeta);
    expect(result.events).toHaveLength(0);
  });

  it("extracts context and networkLogs", () => {
    const context = {
      prompt: "Do something",
      appendSystemPrompt: null,
      secretNames: ["API_KEY"],
      vars: { FOO: "bar" },
      environment: {},
      firewalls: [],
      volumes: [],
      artifact: null,
      memory: null,
    };
    const networkLogs = [
      {
        timestamp: "2026-04-01T00:00:01.000Z",
        type: "http",
        method: "GET",
        url: "https://example.com",
        status: 200,
      },
    ];
    const input = {
      meta: { id: "abc-123", displayName: "Test Agent" },
      events: [
        {
          sequenceNumber: 1,
          eventType: "system",
          eventData: { subtype: "init" },
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      context,
      networkLogs,
    };

    const result = parseInspectLog(JSON.stringify(input));

    expect(result.meta).toStrictEqual(input.meta);
    expect(result.context).toStrictEqual(context);
    expect(result.networkLogs).toStrictEqual(networkLogs);
    expect(result.events).toHaveLength(1);
  });
});
