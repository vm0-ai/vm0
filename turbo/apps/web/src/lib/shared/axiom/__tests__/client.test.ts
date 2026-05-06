import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @axiomhq/js at the package boundary.
const mockQuery = vi.fn();
const mockIngest = vi.fn();
const mockFlush = vi.fn();
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: vi.fn().mockImplementation(function () {
      return { query: mockQuery, ingest: mockIngest, flush: mockFlush };
    }),
  };
});
vi.mock("@axiomhq/logging", () => {
  return {
    EVENT: Symbol("EVENT"),
    Logger: vi.fn().mockImplementation(function () {
      return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      };
    }),
    AxiomJSTransport: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

import { reloadEnv } from "../../../../env";
import {
  queryAxiom,
  ingestToAxiom,
  flushAxiom,
  ingestSandboxOpLog,
} from "../client";

beforeEach(() => {
  vi.stubEnv("AXIOM_TOKEN_TELEMETRY", "test-telemetry-token");
  vi.stubEnv("AXIOM_TOKEN_SESSIONS", "test-sessions-token");
  reloadEnv();
  mockQuery.mockReset();
  mockIngest.mockReset();
  mockFlush.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function axiomResponse(events: Array<Record<string, unknown>>) {
  return {
    matches: events.map((data) => {
      return {
        _time: "2026-01-01T00:00:00.000Z",
        data,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// ingestToAxiom
// ---------------------------------------------------------------------------

describe("ingestToAxiom", () => {
  it("buffers events without flushing", () => {
    const result = ingestToAxiom("vm0-test-dataset-dev", [{ key: "value" }]);

    expect(result).toBe(true);
    expect(mockIngest).toHaveBeenCalledWith("vm0-test-dataset-dev", [
      { key: "value" },
    ]);
    expect(mockFlush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// flushAxiom
// ---------------------------------------------------------------------------

describe("flushAxiom", () => {
  it("flushes all clients", async () => {
    mockFlush.mockResolvedValue(undefined);

    // Trigger client initialization by ingesting something
    ingestToAxiom("vm0-sandbox-telemetry-system-dev", [{ a: 1 }]);
    await flushAxiom();

    expect(mockFlush).toHaveBeenCalled();
  });

  it("throws flush failures when requested", async () => {
    mockFlush.mockRejectedValue(new Error("flush down"));

    ingestToAxiom("vm0-sandbox-telemetry-system-dev", [{ a: 1 }]);

    await expect(flushAxiom({ throwOnError: true })).rejects.toThrow(
      "Axiom flush failed",
    );
  });

  it("can flush only the sessions client", async () => {
    mockFlush.mockResolvedValue(undefined);

    ingestToAxiom("vm0-agent-run-events-dev", [{ a: 1 }]);
    ingestToAxiom("vm0-sandbox-telemetry-system-dev", [{ b: 2 }]);

    await flushAxiom({ client: "sessions" });

    expect(mockFlush).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ingestSandboxOpLog — web-chat source with extended dims
// ---------------------------------------------------------------------------

describe("ingestSandboxOpLog web-chat source", () => {
  it("buffers to the sandbox-op-log dataset with extra dims preserved", () => {
    ingestSandboxOpLog({
      source: "web-chat",
      op_type: "api_chat_send_auth",
      sandbox_type: "chat",
      duration_ms: 7,
      user_id: "user-x",
      agent_id: "agent-y",
      thread_id: "thread-z",
    });

    expect(mockIngest).toHaveBeenCalledTimes(1);
    const [dataset, events] = mockIngest.mock.calls[0]!;
    expect(dataset).toMatch(/^vm0-sandbox-op-log-/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "web-chat",
      op_type: "api_chat_send_auth",
      sandbox_type: "chat",
      duration_ms: 7,
      user_id: "user-x",
      agent_id: "agent-y",
      thread_id: "thread-z",
    });
    expect(events[0]._time).toMatch(/T/);
  });
});

// ---------------------------------------------------------------------------
// queryAxiom — retry behavior
// ---------------------------------------------------------------------------

describe("queryAxiom", () => {
  const apl = "['vm0-agent-run-events-dev'] | where runId == \"run-1\"";

  it("returns results on successful query", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([{ eventType: "result", eventData: { result: "hello" } }]),
    );

    const results = await queryAxiom(apl);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ eventType: "result" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("retries on rate limit error and succeeds", async () => {
    mockQuery
      .mockRejectedValueOnce(new Error("429 rate limit"))
      .mockResolvedValueOnce(axiomResponse([{ eventType: "result" }]));

    const promise = queryAxiom(apl);
    await vi.advanceTimersByTimeAsync(2000);
    const results = await promise;

    expect(results).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on persistent rate limit", async () => {
    mockQuery.mockRejectedValue(new Error("429 rate limit"));

    // Attach catch immediately to prevent unhandled rejection
    const promise = queryAxiom(apl).catch((e: unknown) => {
      return e;
    });
    // Advance through all 3 retry backoffs: 2s + 4s + 8s = 14s
    await vi.advanceTimersByTimeAsync(20_000);

    const error = await promise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("429 rate limit");
    // 1 initial + 3 retries = 4 total attempts
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it("does not retry on non-rate-limit errors", async () => {
    mockQuery.mockRejectedValue(new Error("network timeout"));

    await expect(queryAxiom(apl)).rejects.toThrow("network timeout");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("supports disabling rate-limit retries", async () => {
    mockQuery.mockRejectedValue(new Error("429 rate limit"));

    await expect(queryAxiom(apl, { maxRetries: 0 })).rejects.toThrow(
      "429 rate limit",
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
