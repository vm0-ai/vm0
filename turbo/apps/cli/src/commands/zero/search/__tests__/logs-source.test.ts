/**
 * Parity test for `zero search --source logs` vs `zero logs search`.
 *
 * Entry point: parseAsync() on both commands
 * Mock (external): Web API via MSW (same stub for both)
 * Real (internal): all CLI code, event parsers, renderers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroSearchCommand } from "../index";
import { searchCommand } from "../../logs/search";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function stubResponse() {
  return HttpResponse.json({
    results: [
      {
        runId: "abc12345-1234-1234-1234-123456789abc",
        agentName: "my-agent",
        matchedEvent: {
          sequenceNumber: 3,
          eventType: "assistant",
          createdAt: "2024-01-15T10:30:00Z",
          eventData: {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Build failed: OOM killed" }],
            },
          },
        },
        contextBefore: [],
        contextAfter: [],
      },
    ],
    hasMore: false,
  });
}

async function capture(
  cmd: { parseAsync: (argv: string[]) => Promise<unknown> },
  argv: string[],
): Promise<string> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  try {
    await cmd.parseAsync(argv);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("zero search --source logs parity with zero logs search", () => {
  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    zeroSearchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces identical output for the same query and flags", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", stubResponse),
    );

    const viaSearch = await capture(zeroSearchCommand, [
      "node",
      "cli",
      "OOM",
      "--source",
      "logs",
      "--agent",
      AGENT_ID,
      "--limit",
      "5",
      "-C",
      "1",
    ]);

    zeroSearchCommand.setOptionValue("source", []);

    const viaLogsSearch = await capture(searchCommand, [
      "node",
      "cli",
      "OOM",
      "--agent",
      AGENT_ID,
      "--limit",
      "5",
      "-C",
      "1",
    ]);

    expect(viaSearch).toBe(viaLogsSearch);
    expect(viaSearch).toContain("OOM killed");
  });

  it("forwards filter flags to the API identically", async () => {
    const captured: URL[] = [];
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", ({ request }) => {
        captured.push(new URL(request.url));
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "error",
      "--source",
      "logs",
      "--agent",
      AGENT_ID,
      "--run",
      "abc12345-1234-1234-1234-123456789abc",
      "--since",
      "3d",
      "--limit",
      "10",
      "-A",
      "2",
      "-B",
      "1",
    ]);

    expect(captured).toHaveLength(1);
    const url = captured[0]!;
    expect(url.searchParams.get("keyword")).toBe("error");
    expect(url.searchParams.get("agentId")).toBe(AGENT_ID);
    expect(url.searchParams.get("runId")).toBe(
      "abc12345-1234-1234-1234-123456789abc",
    );
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("before")).toBe("1");
    expect(url.searchParams.get("after")).toBe("2");
  });
});
