import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectionStateChange, InboundMessage } from "ably";

// Track registered listeners
let connectionListeners: Map<
  string,
  (stateChange: ConnectionStateChange) => void
>;
let messageHandler: ((message: InboundMessage) => void) | null;

// Mock Ably
vi.mock("ably", () => {
  return {
    default: {
      Realtime: vi.fn().mockImplementation(() => {
        connectionListeners = new Map();
        messageHandler = null;

        return {
          connection: {
            on: vi.fn((eventOrCallback, callback?) => {
              if (typeof eventOrCallback === "string") {
                connectionListeners.set(eventOrCallback, callback);
              } else {
                // Generic listener for all state changes
                connectionListeners.set("*", eventOrCallback);
              }
            }),
          },
          channels: {
            get: vi.fn().mockReturnValue({
              subscribe: vi.fn((handler: (message: InboundMessage) => void) => {
                messageHandler = handler;
                return Promise.resolve();
              }),
              unsubscribe: vi.fn(),
            }),
          },
          close: vi.fn(),
        };
      }),
    },
  };
});

// Mock the api module
vi.mock("../../api.js", () => ({
  getRealtimeToken: vi.fn().mockResolvedValue({
    keyName: "test-key",
    timestamp: Date.now(),
    capability: '{"runner-group:test":["subscribe"]}',
    nonce: "test-nonce",
    mac: "test-mac",
  }),
}));

import { subscribeToJobs } from "../subscription.js";

describe("realtime/subscription", () => {
  const mockServer = {
    url: "https://api.vm0.dev",
    token: "test-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connectionListeners = new Map();
    messageHandler = null;
  });

  describe("subscribeToJobs", () => {
    it("should subscribe to the correct channel", async () => {
      const onJob = vi.fn();

      const subscription = await subscribeToJobs(
        mockServer,
        "vm0/production",
        onJob,
      );

      expect(subscription).toBeDefined();
      expect(subscription.client).toBeDefined();
      expect(subscription.cleanup).toBeInstanceOf(Function);
    });

    it("should call onJob when a job message is received", async () => {
      const onJob = vi.fn();

      await subscribeToJobs(mockServer, "vm0/production", onJob);

      // Simulate receiving a job message
      expect(messageHandler).toBeDefined();
      messageHandler!({
        name: "job",
        data: { runId: "test-run-123" },
      } as InboundMessage);

      expect(onJob).toHaveBeenCalledTimes(1);
      expect(onJob).toHaveBeenCalledWith({ runId: "test-run-123" });
    });

    it("should ignore non-job messages", async () => {
      const onJob = vi.fn();

      await subscribeToJobs(mockServer, "vm0/production", onJob);

      // Simulate receiving a non-job message
      messageHandler!({
        name: "other",
        data: { foo: "bar" },
      } as InboundMessage);

      expect(onJob).not.toHaveBeenCalled();
    });

    it("should log error for invalid job notification data", async () => {
      const onJob = vi.fn();
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await subscribeToJobs(mockServer, "vm0/production", onJob);

      // Simulate receiving a job message with invalid data (missing runId)
      messageHandler!({
        name: "job",
        data: { invalid: "data" },
      } as InboundMessage);

      expect(onJob).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Invalid job notification:",
        expect.any(Array),
      );

      consoleErrorSpy.mockRestore();
    });

    it("should call onConnectionChange when connection state changes", async () => {
      const onJob = vi.fn();
      const onConnectionChange = vi.fn();

      await subscribeToJobs(
        mockServer,
        "vm0/production",
        onJob,
        onConnectionChange,
      );

      // Simulate connection state change
      const genericListener = connectionListeners.get("*");
      expect(genericListener).toBeDefined();

      genericListener!({
        current: "connected",
        previous: "connecting",
      } as ConnectionStateChange);

      expect(onConnectionChange).toHaveBeenCalledWith("connected", undefined);
    });

    it("should pass reason message when connection state changes with error", async () => {
      const onJob = vi.fn();
      const onConnectionChange = vi.fn();

      await subscribeToJobs(
        mockServer,
        "vm0/production",
        onJob,
        onConnectionChange,
      );

      const genericListener = connectionListeners.get("*");
      genericListener!({
        current: "disconnected",
        previous: "connected",
        reason: { message: "Network error" },
      } as ConnectionStateChange);

      expect(onConnectionChange).toHaveBeenCalledWith(
        "disconnected",
        "Network error",
      );
    });

    it("should register failed connection handler", async () => {
      const onJob = vi.fn();

      await subscribeToJobs(mockServer, "vm0/production", onJob);

      // Verify failed handler was registered
      expect(connectionListeners.has("failed")).toBe(true);
    });

    it("should cleanup properly when cleanup is called", async () => {
      const onJob = vi.fn();

      const subscription = await subscribeToJobs(
        mockServer,
        "vm0/production",
        onJob,
      );

      // Call cleanup
      subscription.cleanup();

      // Verify close was called on client
      expect(subscription.client.close).toHaveBeenCalled();
    });
  });
});
