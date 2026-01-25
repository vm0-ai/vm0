import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Ably from "ably";

// Create shared mock functions that can be accessed in tests
const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockCreateTokenRequest = vi.fn().mockResolvedValue({
  keyName: "test-key",
  timestamp: Date.now(),
  capability: '{"run:test-run-id":["subscribe"]}',
  nonce: "test-nonce",
  mac: "test-mac",
});

// Mock Ably (third-party external dependency)
vi.mock("ably", () => {
  const mockChannel = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const mockChannels = { get: vi.fn().mockReturnValue(mockChannel) };
  const mockAuth = {
    createTokenRequest: vi.fn().mockResolvedValue({
      keyName: "test-key",
      timestamp: Date.now(),
      capability: '{"run:test-run-id":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    }),
  };

  return {
    default: {
      Rest: vi.fn().mockImplementation(() => ({
        channels: mockChannels,
        auth: mockAuth,
      })),
    },
  };
});

describe("realtime/client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module cache to get fresh singleton state
    vi.resetModules();
    // Reset mock implementations
    mockPublish.mockResolvedValue(undefined);
    mockCreateTokenRequest.mockResolvedValue({
      keyName: "test-key",
      timestamp: Date.now(),
      capability: '{"run:test-run-id":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("publishEvents", () => {
    it("should return false when ABLY_API_KEY is not configured", async () => {
      // ABLY_API_KEY is not set by default
      const { publishEvents } = await import("../client");

      const result = await publishEvents("run-123", [{ type: "test" }], 1);

      expect(result).toBe(false);
    });

    it("should publish events to the correct channel when configured", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");
      const { publishEvents } = await import("../client");

      const events = [{ type: "test", data: "value" }];
      const result = await publishEvents("run-123", events, 5);

      expect(result).toBe(true);

      // Verify Ably.Rest was instantiated
      expect(Ably.Rest).toHaveBeenCalledTimes(1);

      // Get the mock instance
      const mockInstance = vi.mocked(Ably.Rest).mock.results[0]?.value as {
        channels: { get: ReturnType<typeof vi.fn> };
      };
      expect(mockInstance.channels.get).toHaveBeenCalledWith("run:run-123");
    });

    it("should return false and not throw when publish fails", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");

      // Make publish fail by re-mocking
      vi.mocked(Ably.Rest).mockImplementationOnce(() => {
        const failingChannel = {
          publish: vi.fn().mockRejectedValue(new Error("Publish failed")),
        };
        return {
          channels: { get: vi.fn().mockReturnValue(failingChannel) },
          auth: { createTokenRequest: vi.fn() },
        } as unknown as Ably.Rest;
      });

      const { publishEvents } = await import("../client");
      const result = await publishEvents("run-123", [], 0);

      expect(result).toBe(false);
    });
  });

  describe("publishStatus", () => {
    it("should return false when ABLY_API_KEY is not configured", async () => {
      // ABLY_API_KEY is not set by default
      const { publishStatus } = await import("../client");

      const result = await publishStatus("run-123", "completed", {
        foo: "bar",
      });

      expect(result).toBe(false);
    });

    it("should publish status to the correct channel when configured", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");
      const { publishStatus } = await import("../client");

      const result = await publishStatus(
        "run-456",
        "failed",
        undefined,
        "Test error",
      );

      expect(result).toBe(true);
      expect(Ably.Rest).toHaveBeenCalledTimes(1);
    });
  });

  describe("generateRunToken", () => {
    it("should return null when ABLY_API_KEY is not configured", async () => {
      // ABLY_API_KEY is not set by default
      const { generateRunToken } = await import("../client");

      const result = await generateRunToken("run-123");

      expect(result).toBe(null);
    });

    it("should generate token with correct capability when configured", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");
      const { generateRunToken } = await import("../client");

      const result = await generateRunToken("run-789");

      expect(result).not.toBe(null);
      expect(result?.keyName).toBe("test-key");
      expect(Ably.Rest).toHaveBeenCalledTimes(1);

      // Verify createTokenRequest was called with correct params
      const mockInstance = vi.mocked(Ably.Rest).mock.results[0]?.value as {
        auth: { createTokenRequest: ReturnType<typeof vi.fn> };
      };
      expect(mockInstance.auth.createTokenRequest).toHaveBeenCalledWith({
        capability: {
          "run:run-789": ["subscribe"],
        },
        ttl: 3600000,
      });
    });

    it("should return null when token generation fails", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");

      // Make token generation fail
      vi.mocked(Ably.Rest).mockImplementationOnce(() => {
        return {
          channels: { get: vi.fn() },
          auth: {
            createTokenRequest: vi
              .fn()
              .mockRejectedValue(new Error("Token gen failed")),
          },
        } as unknown as Ably.Rest;
      });

      const { generateRunToken } = await import("../client");
      const result = await generateRunToken("run-123");

      expect(result).toBe(null);
    });
  });
});
