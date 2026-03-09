import { describe, it, expect, vi, beforeEach } from "vitest";

import { startHeartbeat, resetShutdown } from "../scripts/lib/heartbeat.js";

// Suppress log output by mocking console.error (used by log.ts)
vi.spyOn(console, "error").mockImplementation(() => {});

describe("heartbeat", () => {
  const mockPostJson =
    vi.fn<
      (
        url: string,
        data: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null>
    >();

  beforeEach(() => {
    resetShutdown();
    mockPostJson.mockReset();
  });

  describe("startHeartbeat", () => {
    const baseConfig = {
      heartbeatUrl: "https://api.example.com/heartbeat",
      runId: "test-run-123",
      intervalSeconds: 60,
    };

    function configWith(
      overrides: Partial<Parameters<typeof startHeartbeat>[0]> = {},
    ) {
      return { ...baseConfig, postJson: mockPostJson, ...overrides };
    }

    it("should reject when first heartbeat returns null", async () => {
      mockPostJson.mockResolvedValue(null);

      // Use scheduler that never fires (we only care about first heartbeat)
      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat(configWith({ scheduleNext }));

      await expect(heartbeatPromise).rejects.toThrow(
        "Network connectivity check failed",
      );
      expect(scheduleNext).not.toHaveBeenCalled(); // Loop should stop
    });

    it("should reject when first heartbeat throws error", async () => {
      mockPostJson.mockRejectedValue(new Error("Network error"));

      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat(configWith({ scheduleNext }));

      await expect(heartbeatPromise).rejects.toThrow(
        "Network connectivity check failed",
      );
      expect(scheduleNext).not.toHaveBeenCalled(); // Loop should stop
    });

    it("should schedule next heartbeat when first succeeds", async () => {
      mockPostJson.mockResolvedValue({});

      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat(configWith({ scheduleNext }));

      // Prevent unhandled rejection
      heartbeatPromise.catch(() => {});

      // Wait for first heartbeat to complete
      await vi.waitFor(() => {
        expect(mockPostJson).toHaveBeenCalledTimes(1);
      });

      // Verify next heartbeat was scheduled
      expect(scheduleNext).toHaveBeenCalledTimes(1);
      expect(scheduleNext).toHaveBeenCalledWith(
        expect.any(Function),
        baseConfig.intervalSeconds * 1000,
      );
    });

    it("should continue sending heartbeats after first success", async () => {
      mockPostJson.mockResolvedValue({});

      // Capture scheduled callbacks
      const scheduledCallbacks: Array<() => void> = [];
      const scheduleNext = vi.fn((callback: () => void) => {
        scheduledCallbacks.push(callback);
      });

      const heartbeatPromise = startHeartbeat(configWith({ scheduleNext }));
      heartbeatPromise.catch(() => {});

      // Wait for first heartbeat
      await vi.waitFor(() => {
        expect(mockPostJson).toHaveBeenCalledTimes(1);
      });

      // Trigger second heartbeat
      scheduledCallbacks[0]?.();
      await vi.waitFor(() => {
        expect(mockPostJson).toHaveBeenCalledTimes(2);
      });

      // Trigger third heartbeat
      scheduledCallbacks[1]?.();
      await vi.waitFor(() => {
        expect(mockPostJson).toHaveBeenCalledTimes(3);
      });
    });

    it("should not reject when subsequent heartbeat fails", async () => {
      // First heartbeat succeeds, subsequent ones fail
      mockPostJson
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(null)
        .mockResolvedValue({});

      const scheduledCallbacks: Array<() => void> = [];
      const scheduleNext = vi.fn((callback: () => void) => {
        scheduledCallbacks.push(callback);
      });

      const heartbeatPromise = startHeartbeat(configWith({ scheduleNext }));

      // Track if promise rejects
      let rejected = false;
      heartbeatPromise.catch(() => {
        rejected = true;
      });

      // Wait for first heartbeat (success)
      await vi.waitFor(() => {
        expect(mockPostJson).toHaveBeenCalledTimes(1);
      });

      // Trigger second heartbeat (fails - should just warn)
      scheduledCallbacks[0]?.();
      await vi.waitFor(() => {
        expect(mockPostJson).toHaveBeenCalledTimes(2);
      });

      // Trigger third heartbeat (succeeds)
      scheduledCallbacks[1]?.();
      await vi.waitFor(() => {
        expect(mockPostJson).toHaveBeenCalledTimes(3);
      });

      // Promise should not reject
      expect(rejected).toBe(false);
    });

    it("should stop heartbeat loop when first heartbeat fails", async () => {
      mockPostJson.mockResolvedValue(null);

      const scheduleNext = vi.fn();
      const heartbeatPromise = startHeartbeat(configWith({ scheduleNext }));

      await expect(heartbeatPromise).rejects.toThrow();

      // Verify only one call was made (loop stopped)
      expect(mockPostJson).toHaveBeenCalledTimes(1);

      // Verify no next heartbeat was scheduled
      expect(scheduleNext).not.toHaveBeenCalled();
    });
  });
});
