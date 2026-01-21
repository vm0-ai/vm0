import { describe, it, expect, vi, beforeEach } from "vitest";
import Ably from "ably";

// Mock Ably (third-party external dependency)
vi.mock("ably", () => ({
  default: {
    Realtime: vi.fn(),
  },
}));

import { createRealtimeClient, getRunChannelName } from "../client";

describe("realtime/client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRunChannelName", () => {
    it("should return channel name in correct format", () => {
      expect(getRunChannelName("run-123")).toBe("run:run-123");
    });

    it("should handle UUID run IDs", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      expect(getRunChannelName(uuid)).toBe(`run:${uuid}`);
    });
  });

  describe("createRealtimeClient", () => {
    it("should create Ably Realtime client with authCallback", () => {
      const mockGetToken = vi.fn();

      createRealtimeClient(mockGetToken);

      expect(Ably.Realtime).toHaveBeenCalledTimes(1);
      const config = vi.mocked(Ably.Realtime).mock.calls[0]?.[0] as {
        authCallback?: unknown;
      };
      expect(config).toHaveProperty("authCallback");
      expect(typeof config.authCallback).toBe("function");
    });

    it("should call getToken and invoke callback with token on success", async () => {
      const mockToken = {
        keyName: "test-key",
        timestamp: Date.now(),
        capability: '{"run:test":["subscribe"]}',
        nonce: "test-nonce",
        mac: "test-mac",
      };
      const mockGetToken = vi.fn().mockResolvedValue(mockToken);
      const mockCallback = vi.fn();

      createRealtimeClient(mockGetToken);

      // Get the authCallback from the config
      const config = vi.mocked(Ably.Realtime).mock.calls[0]?.[0] as {
        authCallback?: (
          params: unknown,
          callback: (err: unknown, token: unknown) => void,
        ) => void;
      };
      const authCallback = config.authCallback;

      // Call the authCallback
      authCallback?.({}, mockCallback);

      // Wait for the Promise to resolve
      await vi.waitFor(() => {
        expect(mockGetToken).toHaveBeenCalled();
      });

      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalledWith(null, mockToken);
      });
    });

    it("should call callback with error when getToken fails", async () => {
      const mockError = new Error("Token fetch failed");
      const mockGetToken = vi.fn().mockRejectedValue(mockError);
      const mockCallback = vi.fn();

      createRealtimeClient(mockGetToken);

      // Get the authCallback from the config
      const config = vi.mocked(Ably.Realtime).mock.calls[0]?.[0] as {
        authCallback?: (
          params: unknown,
          callback: (err: unknown, token: unknown) => void,
        ) => void;
      };
      const authCallback = config.authCallback;

      // Call the authCallback
      authCallback?.({}, mockCallback);

      // Wait for the Promise to reject and callback to be called
      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalled();
      });

      const errorArg = mockCallback.mock.calls[0]?.[0] as {
        name: string;
        message: string;
        code: number;
        statusCode: number;
      };
      expect(errorArg).toMatchObject({
        name: "AuthError",
        message: "Token fetch failed",
        code: 40100,
        statusCode: 401,
      });
      expect(mockCallback.mock.calls[0]?.[1]).toBe(null);
    });

    it("should handle non-Error rejections", async () => {
      const mockGetToken = vi.fn().mockRejectedValue("string error");
      const mockCallback = vi.fn();

      createRealtimeClient(mockGetToken);

      const config = vi.mocked(Ably.Realtime).mock.calls[0]?.[0] as {
        authCallback?: (
          params: unknown,
          callback: (err: unknown, token: unknown) => void,
        ) => void;
      };
      const authCallback = config.authCallback;

      authCallback?.({}, mockCallback);

      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalled();
      });

      const errorArg = mockCallback.mock.calls[0]?.[0] as { message: string };
      expect(errorArg.message).toBe("Token fetch failed");
    });
  });
});
