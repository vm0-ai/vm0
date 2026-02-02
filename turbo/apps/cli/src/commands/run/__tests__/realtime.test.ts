/**
 * Tests for run command with --experimental-realtime flag
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, Ably (third-party realtime service)
 * - Real (internal): All CLI code, realtime client, stream-events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createMockChildProcess } from "../../../mocks/spawn-helpers";
import chalk from "chalk";

// Mock child_process.spawn since it's an external system call boundary
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

import { spawn } from "child_process";
const mockSpawn = vi.mocked(spawn);

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

import { runCommand } from "../index";

describe("run command with --experimental-realtime", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testUuid = "550e8400-e29b-41d4-a716-446655440000";

  // Default compose response for getComposeById
  const defaultComposeResponse = {
    id: testUuid,
    name: "test-agent",
    headVersionId: "version-123",
    content: {
      version: "1",
      agents: { "test-agent": { provider: "claude" } },
    },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  // Default run response
  const defaultRunResponse = {
    runId: "run-123",
    status: "running",
    sandboxId: "sbx-456",
    output: "Success",
    executionTimeMs: 1000,
    createdAt: "2025-01-01T00:00:00Z",
  };

  // Mock realtime token response
  const mockRealtimeToken = {
    keyName: "test-key",
    timestamp: Date.now(),
    capability: '{"run:run-123":["subscribe"]}',
    nonce: "test-nonce",
    mac: "test-mac",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;

    // Disable chalk colors for deterministic console output assertions
    chalk.level = 0;

    // Use environment variables for config
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Default handlers for most tests
    server.use(
      http.get("http://localhost:3000/api/agent/composes/:id", () => {
        return HttpResponse.json(defaultComposeResponse);
      }),
      http.post("http://localhost:3000/api/agent/runs", () => {
        return HttpResponse.json(defaultRunResponse, { status: 201 });
      }),
      http.post("http://localhost:3000/api/realtime/token", () => {
        return HttpResponse.json(mockRealtimeToken, { status: 200 });
      }),
      // Default npm registry handler - return same version to skip upgrade
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    // Default spawn mock - succeeds immediately
    mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("successful streaming", () => {
    it("should stream events and complete successfully", async () => {
      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      // Wait for subscription to be set up
      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      // Simulate events message
      capturedMessageHandler?.({
        name: "events",
        data: {
          events: [{ type: "text", sequenceNumber: 0, text: "Hello" }],
          nextSequence: 1,
        },
      });

      // Simulate completion
      capturedMessageHandler?.({
        name: "status",
        data: {
          status: "completed",
          result: {
            checkpointId: "cp-123",
            agentSessionId: "session-456",
          },
        },
      });

      await runPromise;

      // Verify run started message
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("run-123"),
      );

      // Verify cleanup was called
      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it("should call onEvent for each event in events message", async () => {
      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      // Simulate multiple events
      capturedMessageHandler?.({
        name: "events",
        data: {
          events: [
            {
              type: "assistant",
              sequenceNumber: 0,
              message: { content: "Hello" },
            },
            {
              type: "assistant",
              sequenceNumber: 1,
              message: { content: "World" },
            },
          ],
          nextSequence: 2,
        },
      });

      // Complete the stream
      capturedMessageHandler?.({
        name: "status",
        data: { status: "completed" },
      });

      await runPromise;
    });

    it("should show next steps with session and checkpoint IDs", async () => {
      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      capturedMessageHandler?.({
        name: "status",
        data: {
          status: "completed",
          result: {
            checkpointId: "cp-123",
            agentSessionId: "session-456",
          },
        },
      });

      await runPromise;

      // Should show continue and resume commands
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string")
        .join("\n");

      expect(allLogs).toContain("vm0 run continue session-456");
      expect(allLogs).toContain("vm0 run resume cp-123");
    });
  });

  describe("stream failure handling", () => {
    it("should handle failed status and exit with code 1", async () => {
      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      // Simulate failure
      capturedMessageHandler?.({
        name: "status",
        data: { status: "failed", error: "Something went wrong" },
      });

      await expect(runPromise).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      // Error message is rendered via EventRenderer.renderRunFailed using console.log
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Something went wrong"),
      );
    });

    it("should handle timeout status and exit with code 1", async () => {
      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      // Simulate timeout
      capturedMessageHandler?.({
        name: "status",
        data: { status: "timeout" },
      });

      await expect(runPromise).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
      );
    });
  });

  describe("cleanup", () => {
    it("should cleanup (unsubscribe and close) after completion", async () => {
      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      capturedMessageHandler?.({
        name: "status",
        data: { status: "completed" },
      });

      await runPromise;

      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it("should cleanup after failure", async () => {
      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      capturedMessageHandler?.({
        name: "status",
        data: { status: "failed", error: "Error" },
      });

      await expect(runPromise).rejects.toThrow("process.exit called");

      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("sequence handling", () => {
    it("should log warning for sequence gaps", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const runPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--experimental-realtime",
      ]);

      await vi.waitFor(() => {
        expect(capturedMessageHandler).not.toBeNull();
      });

      // Send event with a gap (expecting 0, receiving 5 skips sequences 0-4)
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

      await runPromise;
      consoleSpy.mockRestore();
    });
  });
});
