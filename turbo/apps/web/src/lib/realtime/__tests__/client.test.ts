import { describe, it, expect, vi, beforeEach } from "vitest";
import Ably from "ably";

// Create shared mock functions that can be accessed in tests
const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockCreateTokenRequest = vi.fn().mockResolvedValue({
  keyName: "test-key",
  timestamp: Date.now(),
  capability: '{"runner-group:vm0/production":["subscribe"]}',
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
      capability: '{"runner-group:vm0/production":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    }),
  };

  return {
    default: {
      Rest: vi.fn().mockImplementation(function () {
        return {
          channels: mockChannels,
          auth: mockAuth,
        };
      }),
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
      capability: '{"runner-group:vm0/production":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    });
  });

  describe("generateRunnerGroupToken", () => {
    it("should return null when ABLY_API_KEY is not configured", async () => {
      const { generateRunnerGroupToken } = await import("../client");

      const result = await generateRunnerGroupToken("vm0/production");

      expect(result).toBe(null);
    });

    it("should generate token with correct capability when configured", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");
      const { generateRunnerGroupToken } = await import("../client");

      const result = await generateRunnerGroupToken("vm0/production");

      expect(result).not.toBe(null);
      expect(result?.keyName).toBe("test-key");
      expect(Ably.Rest).toHaveBeenCalledTimes(1);

      // Verify createTokenRequest was called with correct params
      const mockInstance = vi.mocked(Ably.Rest).mock.results[0]?.value as {
        auth: { createTokenRequest: ReturnType<typeof vi.fn> };
      };
      expect(mockInstance.auth.createTokenRequest).toHaveBeenCalledWith({
        capability: {
          "runner-group:vm0/production": ["subscribe"],
        },
        ttl: 3600000,
      });
    });

    it("should return null when token generation fails", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");

      vi.mocked(Ably.Rest).mockImplementationOnce(function () {
        return {
          channels: { get: vi.fn() },
          auth: {
            createTokenRequest: vi
              .fn()
              .mockRejectedValue(new Error("Token gen failed")),
          },
        } as unknown as Ably.Rest;
      });

      const { generateRunnerGroupToken } = await import("../client");
      const result = await generateRunnerGroupToken("vm0/production");

      expect(result).toBe(null);
    });
  });

  describe("publishJobNotification", () => {
    it("should return false when ABLY_API_KEY is not configured", async () => {
      const { publishJobNotification } = await import("../client");

      const result = await publishJobNotification("vm0/production", "run-123");

      expect(result).toBe(false);
    });

    it("should publish job notification to the correct channel when configured", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");
      const { publishJobNotification } = await import("../client");

      const result = await publishJobNotification("vm0/production", "run-456");

      expect(result).toBe(true);
      expect(Ably.Rest).toHaveBeenCalledTimes(1);

      // Verify channel name
      const mockInstance = vi.mocked(Ably.Rest).mock.results[0]?.value as {
        channels: { get: ReturnType<typeof vi.fn> };
      };
      expect(mockInstance.channels.get).toHaveBeenCalledWith(
        "runner-group:vm0/production",
      );
    });

    it("should return false and not throw when publish fails", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-api-key");

      vi.mocked(Ably.Rest).mockImplementationOnce(function () {
        const failingChannel = {
          publish: vi.fn().mockRejectedValue(new Error("Publish failed")),
        };
        return {
          channels: { get: vi.fn().mockReturnValue(failingChannel) },
          auth: { createTokenRequest: vi.fn() },
        } as unknown as Ably.Rest;
      });

      const { publishJobNotification } = await import("../client");
      const result = await publishJobNotification("vm0/production", "run-123");

      expect(result).toBe(false);
    });
  });
});
