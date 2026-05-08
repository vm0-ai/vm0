import { describe, expect, it, vi } from "vitest";
import { waitForAgentEventPrefixVisible } from "../agent-event-visibility";

describe("waitForAgentEventPrefixVisible", () => {
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
