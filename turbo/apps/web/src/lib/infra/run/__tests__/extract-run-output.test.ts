import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";

// Mock @axiomhq/js at the package boundary (not internal modules).
// We provide a controllable `query` method that returns Axiom-shaped responses.
const mockQuery = vi.fn();
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: vi.fn().mockImplementation(function () {
      return { query: mockQuery };
    }),
  };
});

import { reloadEnv } from "../../../../env";
import { extractRunOutput } from "../extract-run-output";

/**
 * Helper to build an Axiom query response in the shape returned by the SDK.
 * Each item becomes a match entry with `_time` and `data`.
 */
function axiomResponse(events: Array<Record<string, unknown>>): {
  matches: Array<{ _time: string; data: Record<string, unknown> }>;
} {
  return {
    matches: events.map((data) => {
      return {
        _time: new Date().toISOString(),
        data,
      };
    }),
  };
}

beforeEach(() => {
  vi.stubEnv("AXIOM_TOKEN_SESSIONS", "test-axiom-token");
  // Reload env() cache after stubbing the token so the axiom client sees it
  reloadEnv();
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// extractRunOutput (single — last event)
// ---------------------------------------------------------------------------

describe("extractRunOutput", () => {
  it("returns empty output when no events found", async () => {
    mockQuery.mockResolvedValue(axiomResponse([]));

    const output = await extractRunOutput("run-1", undefined, {
      waitForOutput: false,
    });

    expect(output).toEqual({
      result: null,
      error: null,
    });
  });

  it("returns the result from the single event returned by the limit-1 query", async () => {
    // queryOutputEventsDesc orders newest-first, so the first output event wins.
    mockQuery.mockResolvedValue(
      axiomResponse([{ eventData: { result: "latest" } }]),
    );

    const output = await extractRunOutput("run-1", undefined, {
      waitForOutput: false,
    });

    expect(output.result).toBe("latest");
  });

  it("limits the single-output query after filtering to publishable events", async () => {
    mockQuery.mockResolvedValue(axiomResponse([]));

    await extractRunOutput("run-1", undefined, { waitForOutput: false });

    const apl = mockQuery.mock.calls[0]![0] as string;
    expect(apl).toContain('eventType == "result"');
    expect(apl).toContain("['eventData.item.type'] == \"agent_message\"");
    expect(apl).not.toContain("eventData.item.type ==");
    expect(apl).toContain("| limit 1");
  });

  it("returns Codex agent_message text from item.completed events", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
        {
          eventType: "item.completed",
          eventData: {
            item: {
              type: "agent_message",
              text: "Codex completed text",
            },
          },
        },
      ]),
    );

    const output = await extractRunOutput("run-1", undefined, {
      waitForOutput: false,
    });

    expect(output.result).toBe("Codex completed text");
  });

  it("retries briefly when the latest output event is not searchable yet", async () => {
    mockQuery
      .mockResolvedValueOnce(axiomResponse([]))
      .mockResolvedValueOnce(
        axiomResponse([{ eventData: { result: "eventually indexed" } }]),
      );

    const output = await extractRunOutput("run-1", undefined, {
      outputRetryDelayMs: 0,
    });

    expect(output.result).toBe("eventually indexed");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("does not retry output query after terminal watermark is visible", async () => {
    let visibilityRequests = 0;
    server.use(
      http.post("https://api.axiom.co/v1/datasets/_apl", ({ request }) => {
        visibilityRequests++;
        const url = new URL(request.url);
        expect(url.searchParams.get("nocache")).toBe("true");
        expect(url.searchParams.get("streaming-duration")).toBe("1s");
        return HttpResponse.json(axiomResponse([{ sequenceNumber: 0 }]));
      }),
    );
    mockQuery.mockResolvedValueOnce(axiomResponse([]));

    const output = await extractRunOutput(
      "550e8400-e29b-41d4-a716-446655440000",
      null,
      0,
    );

    expect(output.result).toBeNull();
    expect(visibilityRequests).toBe(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0]![0]).toContain('eventType == "result"');
    expect(mockQuery.mock.calls[0]![0]).toContain(
      "['eventData.item.type'] == \"agent_message\"",
    );
    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ noCache: true });
  });

  it("can skip waiting for output visibility", async () => {
    mockQuery.mockResolvedValue(axiomResponse([]));

    const output = await extractRunOutput("run-1", null, {
      waitForOutput: false,
    });

    expect(output.result).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("skips newer Codex non-message items when finding the latest output", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
        {
          eventType: "item.completed",
          eventData: {
            item: {
              type: "command_execution",
              output: "README.md",
            },
          },
        },
        {
          eventType: "item.completed",
          eventData: {
            item: {
              type: "agent_message",
              text: "Latest agent text",
            },
          },
        },
      ]),
    );

    const output = await extractRunOutput("run-1", undefined, {
      waitForOutput: false,
    });

    expect(output.result).toBe("Latest agent text");
  });

  it("passes error through", async () => {
    mockQuery.mockResolvedValue(axiomResponse([]));

    const output = await extractRunOutput("run-1", "sandbox crashed", {
      waitForOutput: false,
    });

    expect(output.error).toBe("sandbox crashed");
    expect(output.result).toBeNull();
  });
});
