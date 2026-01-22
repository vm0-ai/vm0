import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import * as config from "../../api/config";

// Mock the config module for API client
vi.mock("../../api/config", () => ({
  getApiUrl: vi.fn(),
  getToken: vi.fn(),
}));

// Store the message handler so tests can trigger messages
let capturedMessageHandler: ((message: unknown) => void) | null = null;
let mockSubscribe: ReturnType<typeof vi.fn>;
let mockUnsubscribe: ReturnType<typeof vi.fn>;
let mockClose: ReturnType<typeof vi.fn>;
let mockConnectionOn: ReturnType<typeof vi.fn>;

// Mock Ably (third-party external dependency)
vi.mock("ably", () => {
  return {
    default: {
      Realtime: vi.fn().mockImplementation(() => {
        mockSubscribe = vi.fn().mockImplementation((handler) => {
          capturedMessageHandler = handler;
          return Promise.resolve();
        });
        mockUnsubscribe = vi.fn();
        mockClose = vi.fn();
        mockConnectionOn = vi.fn();

        const mockChannel = {
          subscribe: mockSubscribe,
          unsubscribe: mockUnsubscribe,
        };

        return {
          channels: {
            get: vi.fn().mockReturnValue(mockChannel),
          },
          connection: {
            on: mockConnectionOn,
          },
          close: mockClose,
        };
      }),
    },
  };
});

import { streamEvents, type StreamOptions } from "../stream-events";

describe("streamEvents", () => {
  const mockToken = {
    keyName: "test-key",
    timestamp: Date.now(),
    capability: '{"run:test-run":["subscribe"]}',
    nonce: "test-nonce",
    mac: "test-mac",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;

    // Setup config mocks
    vi.mocked(config.getApiUrl).mockResolvedValue("http://localhost:3000");
    vi.mocked(config.getToken).mockResolvedValue("test-token");

    // Setup MSW handler for realtime token
    server.use(
      http.post("http://localhost:3000/api/realtime/token", () => {
        return HttpResponse.json(mockToken, { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createMockOptions(): StreamOptions & {
    onEventMock: ReturnType<typeof vi.fn>;
    onRunCompletedMock: ReturnType<typeof vi.fn>;
    onRunFailedMock: ReturnType<typeof vi.fn>;
    onTimeoutMock: ReturnType<typeof vi.fn>;
  } {
    const onEventMock = vi.fn().mockReturnValue(new Date());
    const onRunCompletedMock = vi.fn();
    const onRunFailedMock = vi.fn();
    const onTimeoutMock = vi.fn();

    return {
      verbose: false,
      startTimestamp: new Date(),
      onEvent: onEventMock,
      onRunCompleted: onRunCompletedMock,
      onRunFailed: onRunFailedMock,
      onTimeout: onTimeoutMock,
      onEventMock,
      onRunCompletedMock,
      onRunFailedMock,
      onTimeoutMock,
    };
  }

  it("should create Ably client and subscribe to channel", async () => {
    const options = createMockOptions();

    // Start streaming (doesn't resolve until status message)
    const streamPromise = streamEvents("run-123", options);

    // Wait for subscription to be set up
    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    // Simulate completion
    capturedMessageHandler?.({
      name: "status",
      data: { status: "completed", result: {} },
    });

    const result = await streamPromise;
    expect(result.succeeded).toBe(true);
    expect(result.runId).toBe("run-123");
  });

  it("should call onEvent for each event in events message", async () => {
    const options = createMockOptions();

    const streamPromise = streamEvents("run-123", options);

    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    // Simulate events message (sequences are 1-based, matching production behavior)
    const events = [
      { type: "text", sequenceNumber: 1, text: "Hello" },
      { type: "text", sequenceNumber: 2, text: "World" },
    ];
    capturedMessageHandler?.({
      name: "events",
      data: { events, nextSequence: 3 },
    });

    expect(options.onEventMock).toHaveBeenCalledTimes(2);
    expect(options.onEventMock).toHaveBeenNthCalledWith(
      1,
      events[0],
      expect.objectContaining({ verbose: false }),
    );
    expect(options.onEventMock).toHaveBeenNthCalledWith(
      2,
      events[1],
      expect.objectContaining({ verbose: false }),
    );

    // Complete the stream
    capturedMessageHandler?.({
      name: "status",
      data: { status: "completed" },
    });

    await streamPromise;
  });

  it("should call onRunCompleted and resolve with success for completed status", async () => {
    const options = createMockOptions();

    const streamPromise = streamEvents("run-123", options);

    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    const result = {
      checkpointId: "cp-123",
      agentSessionId: "session-456",
    };
    capturedMessageHandler?.({
      name: "status",
      data: { status: "completed", result },
    });

    const streamResult = await streamPromise;

    expect(options.onRunCompletedMock).toHaveBeenCalledWith(
      result,
      expect.any(Object),
    );
    expect(streamResult.succeeded).toBe(true);
    expect(streamResult.runId).toBe("run-123");
    expect(streamResult.checkpointId).toBe("cp-123");
    expect(streamResult.sessionId).toBe("session-456");
  });

  it("should call onRunFailed and resolve with failure for failed status", async () => {
    const options = createMockOptions();

    const streamPromise = streamEvents("run-123", options);

    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    capturedMessageHandler?.({
      name: "status",
      data: { status: "failed", error: "Something went wrong" },
    });

    const streamResult = await streamPromise;

    expect(options.onRunFailedMock).toHaveBeenCalledWith(
      "Something went wrong",
      "run-123",
    );
    expect(streamResult.succeeded).toBe(false);
    expect(streamResult.runId).toBe("run-123");
  });

  it("should call onTimeout and resolve with failure for timeout status", async () => {
    const options = createMockOptions();

    const streamPromise = streamEvents("run-123", options);

    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    capturedMessageHandler?.({
      name: "status",
      data: { status: "timeout" },
    });

    const streamResult = await streamPromise;

    expect(options.onTimeoutMock).toHaveBeenCalledWith("run-123");
    expect(streamResult.succeeded).toBe(false);
  });

  it("should cleanup (unsubscribe and close) after completion", async () => {
    const options = createMockOptions();

    const streamPromise = streamEvents("run-123", options);

    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    capturedMessageHandler?.({
      name: "status",
      data: { status: "completed" },
    });

    await streamPromise;

    expect(mockUnsubscribe).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it("should log warning for sequence gaps", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const options = createMockOptions();

    const streamPromise = streamEvents("run-123", options);

    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    // Send event with a gap (expecting 1, receiving 5 skips sequences 1-4)
    capturedMessageHandler?.({
      name: "events",
      data: {
        events: [{ type: "text", sequenceNumber: 5 }],
        nextSequence: 6,
      },
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("sequence gap detected"),
    );

    // Complete
    capturedMessageHandler?.({
      name: "status",
      data: { status: "completed" },
    });

    await streamPromise;
    consoleSpy.mockRestore();
  });

  it("should pass verbose option to callbacks", async () => {
    const options = createMockOptions();
    options.verbose = true;

    const streamPromise = streamEvents("run-123", options);

    await vi.waitFor(() => {
      expect(capturedMessageHandler).not.toBeNull();
    });

    capturedMessageHandler?.({
      name: "events",
      data: {
        events: [{ type: "text", sequenceNumber: 1 }],
        nextSequence: 2,
      },
    });

    expect(options.onEventMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ verbose: true }),
    );

    capturedMessageHandler?.({
      name: "status",
      data: { status: "completed" },
    });

    await streamPromise;
  });
});
