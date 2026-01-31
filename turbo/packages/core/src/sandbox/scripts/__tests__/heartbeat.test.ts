import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock http-client before importing heartbeat
vi.mock("../src/lib/http-client.js", () => ({
  httpPostJson: vi.fn(),
}));

// Mock log to suppress output during tests
vi.mock("../src/lib/log.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { startHeartbeat, resetShutdown } from "../src/lib/heartbeat.js";
import { httpPostJson } from "../src/lib/http-client.js";

const mockHttpPostJson = vi.mocked(httpPostJson);

describe("heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetShutdown();
    mockHttpPostJson.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("startHeartbeat", () => {
    const config = {
      heartbeatUrl: "https://api.example.com/heartbeat",
      runId: "test-run-123",
      intervalSeconds: 60,
    };

    it("should reject when first heartbeat returns false", async () => {
      mockHttpPostJson.mockResolvedValue(null);

      const heartbeatPromise = startHeartbeat(config);

      // Attach error handler before advancing timers to avoid unhandled rejection
      const rejectPromise = expect(heartbeatPromise).rejects.toThrow(
        "Network connectivity check failed",
      );

      // Let the first heartbeat execute
      await vi.runAllTimersAsync();

      await rejectPromise;
    });

    it("should reject when first heartbeat throws error", async () => {
      mockHttpPostJson.mockRejectedValue(new Error("Network error"));

      const heartbeatPromise = startHeartbeat(config);

      // Attach error handler before advancing timers to avoid unhandled rejection
      const rejectPromise = expect(heartbeatPromise).rejects.toThrow(
        "Network connectivity check failed",
      );

      // Let the first heartbeat execute
      await vi.runAllTimersAsync();

      await rejectPromise;
    });

    it("should not reject when first heartbeat succeeds", async () => {
      mockHttpPostJson.mockResolvedValue({});

      const heartbeatPromise = startHeartbeat(config);

      // Prevent unhandled rejection
      heartbeatPromise.catch(() => {});

      // Let the first heartbeat execute
      await vi.advanceTimersByTimeAsync(100);

      // Verify first heartbeat was sent
      expect(mockHttpPostJson).toHaveBeenCalledWith(config.heartbeatUrl, {
        runId: config.runId,
      });

      // Promise should not reject (verify by checking no rejection occurred)
      let rejected = false;
      heartbeatPromise.catch(() => {
        rejected = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(rejected).toBe(false);
    });

    it("should continue sending heartbeats after first success", async () => {
      mockHttpPostJson.mockResolvedValue({});

      const heartbeatPromise = startHeartbeat(config);
      heartbeatPromise.catch(() => {});

      // First heartbeat
      await vi.advanceTimersByTimeAsync(100);
      expect(mockHttpPostJson).toHaveBeenCalledTimes(1);

      // Advance to next heartbeat interval
      await vi.advanceTimersByTimeAsync(config.intervalSeconds * 1000);
      expect(mockHttpPostJson).toHaveBeenCalledTimes(2);

      // Advance to another heartbeat
      await vi.advanceTimersByTimeAsync(config.intervalSeconds * 1000);
      expect(mockHttpPostJson).toHaveBeenCalledTimes(3);
    });

    it("should not reject when subsequent heartbeat fails", async () => {
      // First heartbeat succeeds, subsequent ones fail
      mockHttpPostJson
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(null)
        .mockResolvedValue({});

      const heartbeatPromise = startHeartbeat(config);
      heartbeatPromise.catch(() => {});

      // First heartbeat succeeds
      await vi.advanceTimersByTimeAsync(100);
      expect(mockHttpPostJson).toHaveBeenCalledTimes(1);

      // Second heartbeat fails (should just warn, not reject)
      await vi.advanceTimersByTimeAsync(config.intervalSeconds * 1000);
      expect(mockHttpPostJson).toHaveBeenCalledTimes(2);

      // Should still continue
      await vi.advanceTimersByTimeAsync(config.intervalSeconds * 1000);
      expect(mockHttpPostJson).toHaveBeenCalledTimes(3);

      // Promise should not reject
      let rejected = false;
      heartbeatPromise.catch(() => {
        rejected = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(rejected).toBe(false);
    });

    it("should stop heartbeat loop when first heartbeat fails", async () => {
      mockHttpPostJson.mockResolvedValue(null);

      const heartbeatPromise = startHeartbeat(config);

      // Attach error handler before advancing timers to avoid unhandled rejection
      const rejectPromise = expect(heartbeatPromise).rejects.toThrow();

      // Let the first heartbeat execute and fail
      await vi.runAllTimersAsync();

      // Verify only one call was made (loop stopped)
      expect(mockHttpPostJson).toHaveBeenCalledTimes(1);

      // Wait for promise to reject
      await rejectPromise;

      // Advance time - no more heartbeats should be sent
      mockHttpPostJson.mockClear();
      await vi.advanceTimersByTimeAsync(config.intervalSeconds * 1000 * 2);
      expect(mockHttpPostJson).toHaveBeenCalledTimes(0);
    });
  });
});
