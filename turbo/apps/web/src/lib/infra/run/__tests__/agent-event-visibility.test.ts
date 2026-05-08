import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { reloadEnv } from "../../../../env";
import {
  getAgentEventPageWatermarkTarget,
  waitForAgentEventPrefixVisible,
  waitForRunEventWatermarkVisible,
} from "../agent-event-visibility";

describe("getAgentEventPageWatermarkTarget", () => {
  it.each([
    {
      name: "skips when no terminal watermark exists",
      lastEventSequence: null,
      since: -1,
      limit: 100,
      expected: null,
    },
    {
      name: "waits for sequence zero when zero is terminal",
      lastEventSequence: 0,
      since: -1,
      limit: 100,
      expected: 0,
    },
    {
      name: "skips when cursor already reached terminal",
      lastEventSequence: 5,
      since: 5,
      limit: 100,
      expected: null,
    },
    {
      name: "caps target to current page",
      lastEventSequence: 50,
      since: -1,
      limit: 1,
      expected: 0,
    },
    {
      name: "caps target to terminal within current page",
      lastEventSequence: 2,
      since: -1,
      limit: 100,
      expected: 2,
    },
    {
      name: "skips invalid page sizes defensively",
      lastEventSequence: 2,
      since: -1,
      limit: 0,
      expected: null,
    },
  ])("$name", ({ lastEventSequence, since, limit, expected }) => {
    expect(
      getAgentEventPageWatermarkTarget(lastEventSequence, since, limit),
    ).toBe(expected);
  });
});

describe("waitForAgentEventPrefixVisible", () => {
  it("skips when the sessions Axiom dataset is not configured", async () => {
    vi.stubEnv("AXIOM_TOKEN_SESSIONS", "");
    reloadEnv();

    const result = await waitForAgentEventPrefixVisible("run-1", 0);

    expect(result).toMatchObject({
      visible: false,
      visibleThrough: -1,
      targetSequence: 0,
      attempts: 0,
      reason: "not_configured",
    });
  });

  it("waits until Axiom exposes the contiguous prefix", async () => {
    let now = 0;
    const queryAxiomFn = vi
      .fn()
      .mockResolvedValueOnce([{ sequenceNumber: 0 }, { sequenceNumber: 2 }])
      .mockResolvedValueOnce([{ sequenceNumber: 1 }, { sequenceNumber: 2 }]);

    const result = await waitForAgentEventPrefixVisible("run-1", 2, {
      timeoutMs: 1_000,
      intervalMs: 10,
      queryAxiomFn,
      now: () => {
        return now;
      },
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(result).toMatchObject({
      visible: true,
      visibleThrough: 2,
      reason: "visible",
    });
    expect(queryAxiomFn).toHaveBeenCalledTimes(2);
    expect(queryAxiomFn).toHaveBeenCalledWith(expect.any(String), {
      maxRetries: 0,
      noCache: true,
      streamingDuration: "1s",
      timeoutMs: 1_000,
    });
  });

  it("uses only sequenceNumber and does not require result events", async () => {
    const queryAxiomFn = vi.fn().mockResolvedValue([
      { sequenceNumber: 0, eventType: "tool_use" },
      { sequenceNumber: 1, eventType: "user" },
    ]);

    const result = await waitForAgentEventPrefixVisible("run-1", 1, {
      queryAxiomFn,
    });

    expect(result.visible).toBe(true);
    expect(result.visibleThrough).toBe(1);
  });

  it("continues querying when the visible prefix spans multiple batches", async () => {
    const queryAxiomFn = vi
      .fn()
      .mockResolvedValueOnce([{ sequenceNumber: 0 }, { sequenceNumber: 1 }])
      .mockResolvedValueOnce([{ sequenceNumber: 2 }, { sequenceNumber: 3 }]);
    const sleep = vi.fn(async () => {});

    const result = await waitForAgentEventPrefixVisible("run-1", 3, {
      timeoutMs: 1_000,
      batchSize: 2,
      queryAxiomFn,
      sleep,
    });

    expect(result).toMatchObject({
      visible: true,
      visibleThrough: 3,
      reason: "visible",
    });
    expect(queryAxiomFn).toHaveBeenCalledTimes(2);
    expect(queryAxiomFn.mock.calls[1]?.[0]).toContain(
      "| where sequenceNumber > 1",
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns timeout when the prefix remains incomplete", async () => {
    let now = 0;
    const queryAxiomFn = vi.fn().mockResolvedValue([{ sequenceNumber: 1 }]);

    const result = await waitForAgentEventPrefixVisible("run-1", 0, {
      timeoutMs: 25,
      intervalMs: 10,
      queryAxiomFn,
      now: () => {
        return now;
      },
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(result).toMatchObject({
      visible: false,
      visibleThrough: -1,
      targetSequence: 0,
      reason: "timeout",
    });
    expect(queryAxiomFn).toHaveBeenCalled();
  });

  it("recovers from transient Axiom query errors", async () => {
    let now = 0;
    const queryAxiomFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("axiom down"))
      .mockResolvedValueOnce([{ sequenceNumber: 0 }]);

    const result = await waitForAgentEventPrefixVisible("run-1", 0, {
      timeoutMs: 1_000,
      intervalMs: 10,
      queryAxiomFn,
      now: () => {
        return now;
      },
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(result).toMatchObject({
      visible: true,
      visibleThrough: 0,
      targetSequence: 0,
      reason: "visible",
    });
    expect(queryAxiomFn).toHaveBeenCalledTimes(2);
  });

  it("fails open after repeated Axiom query errors", async () => {
    let now = 0;
    const queryAxiomFn = vi.fn().mockRejectedValue(new Error("axiom down"));

    const result = await waitForAgentEventPrefixVisible("run-1", 0, {
      timeoutMs: 25,
      intervalMs: 10,
      queryAxiomFn,
      now: () => {
        return now;
      },
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(result).toMatchObject({
      visible: false,
      visibleThrough: -1,
      targetSequence: 0,
      reason: "query_error",
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(queryAxiomFn).toHaveBeenCalledTimes(3);
  });
});

describe("waitForRunEventWatermarkVisible", () => {
  it("returns immediately when no terminal watermark exists", async () => {
    await expect(
      waitForRunEventWatermarkVisible("run-1", null),
    ).resolves.toBeUndefined();
  });

  it("returns the known watermark after Axiom exposes it", async () => {
    vi.stubEnv("AXIOM_TOKEN_SESSIONS", "test-axiom-token");
    reloadEnv();

    let visibilityRequests = 0;
    server.use(
      http.post("https://api.axiom.co/v1/datasets/_apl", () => {
        visibilityRequests++;
        return HttpResponse.json({
          matches: [
            {
              _time: new Date().toISOString(),
              data: { sequenceNumber: 0 },
            },
            {
              _time: new Date().toISOString(),
              data: { sequenceNumber: 1 },
            },
          ],
        });
      }),
    );

    await expect(
      waitForRunEventWatermarkVisible(
        "550e8400-e29b-41d4-a716-446655440000",
        1,
      ),
    ).resolves.toBe(1);
    expect(visibilityRequests).toBe(1);
  });

  it("returns the known watermark when Axiom is not configured", async () => {
    vi.stubEnv("AXIOM_TOKEN_SESSIONS", "");
    reloadEnv();

    await expect(
      waitForRunEventWatermarkVisible(
        "550e8400-e29b-41d4-a716-446655440000",
        0,
      ),
    ).resolves.toBe(0);
  });
});
