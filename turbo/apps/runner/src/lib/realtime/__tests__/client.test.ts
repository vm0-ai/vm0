import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenRequest, ErrorInfo } from "ably";

// Mock Ably
vi.mock("ably", () => {
  const mockConnection = {
    on: vi.fn(),
  };
  const mockChannel = {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn(),
  };
  const mockChannels = {
    get: vi.fn().mockReturnValue(mockChannel),
  };

  return {
    default: {
      Realtime: vi.fn().mockImplementation(() => ({
        connection: mockConnection,
        channels: mockChannels,
        close: vi.fn(),
      })),
    },
  };
});

import Ably from "ably";
import { createRealtimeClient, getRunnerGroupChannelName } from "../client.js";

type AuthCallbackOptions = {
  authCallback: (
    params: unknown,
    callback: (err: unknown, token: unknown) => void,
  ) => void;
};

describe("realtime/client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRunnerGroupChannelName", () => {
    it("should return correct channel name for a group", () => {
      expect(getRunnerGroupChannelName("vm0/production")).toBe(
        "runner-group:vm0/production",
      );
    });

    it("should handle groups with special characters", () => {
      expect(getRunnerGroupChannelName("user/my-scope")).toBe(
        "runner-group:user/my-scope",
      );
    });
  });

  describe("createRealtimeClient", () => {
    it("should create Ably client with authCallback", () => {
      const mockGetToken = vi.fn().mockResolvedValue({
        keyName: "test-key",
        timestamp: Date.now(),
        capability: '{"runner-group:test":["subscribe"]}',
        nonce: "test-nonce",
        mac: "test-mac",
      } as TokenRequest);

      const client = createRealtimeClient(mockGetToken);

      expect(Ably.Realtime).toHaveBeenCalledTimes(1);
      expect(Ably.Realtime).toHaveBeenCalledWith({
        authCallback: expect.any(Function),
      });
      expect(client).toBeDefined();
    });

    it("should call getToken when authCallback is invoked", async () => {
      const mockTokenRequest: TokenRequest = {
        keyName: "test-key",
        timestamp: Date.now(),
        capability: '{"runner-group:test":["subscribe"]}',
        nonce: "test-nonce",
        mac: "test-mac",
      };
      const mockGetToken = vi.fn().mockResolvedValue(mockTokenRequest);

      createRealtimeClient(mockGetToken);

      // Get the authCallback from the Ably.Realtime constructor call
      const constructorCall = vi.mocked(Ably.Realtime).mock.calls[0];
      const options = constructorCall?.[0] as unknown as AuthCallbackOptions;
      const authCallback = options.authCallback;

      // Invoke the authCallback
      const callback = vi.fn();
      authCallback({}, callback);

      // Wait for promise to resolve
      await vi.waitFor(() => {
        expect(mockGetToken).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith(null, mockTokenRequest);
      });
    });

    it("should handle token fetch errors in authCallback", async () => {
      const mockGetToken = vi
        .fn()
        .mockRejectedValue(new Error("Token fetch failed"));

      createRealtimeClient(mockGetToken);

      // Get the authCallback
      const constructorCall = vi.mocked(Ably.Realtime).mock.calls[0];
      const options = constructorCall?.[0] as unknown as AuthCallbackOptions;
      const authCallback = options.authCallback;

      // Invoke the authCallback
      const callback = vi.fn();
      authCallback({}, callback);

      // Wait for promise to reject
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "AuthError",
            message: "Token fetch failed",
            code: 40100,
            statusCode: 401,
          } as ErrorInfo),
          null,
        );
      });
    });

    it("should handle non-Error token fetch failures", async () => {
      const mockGetToken = vi.fn().mockRejectedValue("Unknown error");

      createRealtimeClient(mockGetToken);

      // Get the authCallback
      const constructorCall = vi.mocked(Ably.Realtime).mock.calls[0];
      const options = constructorCall?.[0] as unknown as AuthCallbackOptions;
      const authCallback = options.authCallback;

      // Invoke the authCallback
      const callback = vi.fn();
      authCallback({}, callback);

      // Wait for promise to reject
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Token fetch failed",
          }),
          null,
        );
      });
    });
  });
});
