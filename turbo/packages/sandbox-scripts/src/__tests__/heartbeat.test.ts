import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startHeartbeat, resetShutdown } from "../scripts/lib/heartbeat.js";

function okResponse(): Response {
  return new Response("{}", { status: 200 });
}

function failResponse(): Response {
  return new Response(null, { status: 500 });
}

describe("heartbeat", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetShutdown();
    // Spy on console.error (log module uses it for all levels) to suppress
    // noise and allow assertions on log output in failure tests
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("startHeartbeat", () => {
    const baseConfig = {
      heartbeatUrl: "https://api.example.com/heartbeat",
      runId: "test-run-123",
      intervalSeconds: 60,
    };

    it("should reject when first heartbeat returns null", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(failResponse()),
      );

      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat({ ...baseConfig, scheduleNext });
      heartbeatPromise.catch(() => {}); // Prevent unhandled rejection warning

      await vi.runAllTimersAsync();

      await expect(heartbeatPromise).rejects.toThrow(
        "Network connectivity check failed",
      );
      expect(scheduleNext).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Network connectivity check failed"),
      );
    });

    it("should reject when first heartbeat throws error", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.reject(new Error("Network error")),
      );

      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat({ ...baseConfig, scheduleNext });
      heartbeatPromise.catch(() => {}); // Prevent unhandled rejection warning

      await vi.runAllTimersAsync();

      await expect(heartbeatPromise).rejects.toThrow(
        "Network connectivity check failed",
      );
      expect(scheduleNext).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Network connectivity check failed"),
      );
    });

    it("should schedule next heartbeat when first succeeds", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(okResponse()),
      );

      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat({ ...baseConfig, scheduleNext });
      heartbeatPromise.catch(() => {});

      await vi.runAllTimersAsync();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(scheduleNext).toHaveBeenCalledTimes(1);
      expect(scheduleNext).toHaveBeenCalledWith(
        expect.any(Function),
        baseConfig.intervalSeconds * 1000,
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Heartbeat sent (initial)"),
      );
    });

    it("should continue sending heartbeats after first success", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(okResponse()),
      );

      const scheduledCallbacks: Array<() => void> = [];
      const scheduleNext = vi.fn((callback: () => void) => {
        scheduledCallbacks.push(callback);
      });

      const heartbeatPromise = startHeartbeat({ ...baseConfig, scheduleNext });
      heartbeatPromise.catch(() => {});

      // First heartbeat
      await vi.runAllTimersAsync();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      // Trigger second heartbeat
      scheduledCallbacks[0]?.();
      await vi.runAllTimersAsync();
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);

      // Trigger third heartbeat
      scheduledCallbacks[1]?.();
      await vi.runAllTimersAsync();
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it("should not reject when subsequent heartbeat fails", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      let callCount = 0;
      // First heartbeat: success (1 fetch call)
      // Second heartbeat: all 3 retries fail (3 fetch calls returning 500)
      // Third heartbeat: success (1 fetch call)
      fetchSpy.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(okResponse());
        if (callCount <= 4) return Promise.resolve(failResponse());
        return Promise.resolve(okResponse());
      });

      const scheduledCallbacks: Array<() => void> = [];
      const scheduleNext = vi.fn((callback: () => void) => {
        scheduledCallbacks.push(callback);
      });

      const heartbeatPromise = startHeartbeat({ ...baseConfig, scheduleNext });

      let rejected = false;
      heartbeatPromise.catch(() => {
        rejected = true;
      });

      // Wait for first heartbeat (success)
      await vi.runAllTimersAsync();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Trigger second heartbeat (fails after 3 retries)
      scheduledCallbacks[0]?.();
      await vi.runAllTimersAsync();
      expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retry attempts

      // Trigger third heartbeat (succeeds)
      scheduledCallbacks[1]?.();
      await vi.runAllTimersAsync();
      expect(fetchSpy).toHaveBeenCalledTimes(5);

      expect(rejected).toBe(false);
    });

    it("should stop heartbeat loop when first heartbeat fails", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(failResponse()),
      );

      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat({ ...baseConfig, scheduleNext });
      heartbeatPromise.catch(() => {}); // Prevent unhandled rejection warning

      await vi.runAllTimersAsync();

      await expect(heartbeatPromise).rejects.toThrow();

      // httpPostJson retried 3 times internally, but only 1 heartbeat was attempted
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      expect(scheduleNext).not.toHaveBeenCalled();
    });
  });
});
