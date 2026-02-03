import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createMockChildProcess } from "../../../mocks/spawn-helpers";
import { runCommand } from "../index";
import { collectVolumeVersions } from "../shared";
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

/**
 * CLI Command Integration Tests for --volume-version option
 *
 * Tests the --volume-version parameter parsing and API transmission for:
 * - run command
 * - continue command
 * - resume command
 *
 * The actual volume version override behavior is tested via E2E tests
 * (see e2e/tests/02-parallel/t07-vm0-volume-version-override.bats).
 */
describe("--volume-version option", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testUuid = "550e8400-e29b-41d4-a716-446655440000";
  const testSessionId = "660e8400-e29b-41d4-a716-446655440001";
  const testCheckpointId = "770e8400-e29b-41d4-a716-446655440002";

  // Default compose response
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

  // Default events response with completed status
  const defaultEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1000,
          num_turns: 1,
          result: "Done",
          session_id: "test",
          total_cost_usd: 0,
          usage: {},
        },
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
    hasMore: false,
    nextSequence: 0,
    run: { status: "completed" },
    framework: "claude-code",
  };

  // Default session response
  const defaultSessionResponse = {
    id: testSessionId,
    secretNames: [],
  };

  // Default checkpoint response
  const defaultCheckpointResponse = {
    id: testCheckpointId,
    agentComposeSnapshot: {
      secretNames: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Default handlers
    server.use(
      http.get("http://localhost:3000/api/agent/composes/:id", () => {
        return HttpResponse.json(defaultComposeResponse);
      }),
      http.post("http://localhost:3000/api/agent/runs", () => {
        return HttpResponse.json(defaultRunResponse, { status: 201 });
      }),
      http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
        return HttpResponse.json(defaultEventsResponse);
      }),
      http.get("http://localhost:3000/api/agent/sessions/:id", () => {
        return HttpResponse.json(defaultSessionResponse);
      }),
      http.get("http://localhost:3000/api/agent/checkpoints/:id", () => {
        return HttpResponse.json(defaultCheckpointResponse);
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

  describe("collectVolumeVersions", () => {
    it("should parse single volume version", () => {
      const result = collectVolumeVersions("test-volume=abc123", {});
      expect(result).toEqual({ "test-volume": "abc123" });
    });

    it("should parse multiple volume versions", () => {
      let result = collectVolumeVersions("vol1=v1", {});
      result = collectVolumeVersions("vol2=v2", result);
      expect(result).toEqual({ vol1: "v1", vol2: "v2" });
    });

    it("should handle version with equals sign", () => {
      const result = collectVolumeVersions("vol=hash=abc123", {});
      expect(result).toEqual({ vol: "hash=abc123" });
    });

    it("should reject empty volume name", () => {
      expect(() => collectVolumeVersions("=abc123", {})).toThrow(
        "Invalid volume-version format: =abc123",
      );
    });

    it("should reject empty version", () => {
      expect(() => collectVolumeVersions("test-volume=", {})).toThrow(
        "Invalid volume-version format: test-volume=",
      );
    });

    it("should reject missing equals sign", () => {
      expect(() => collectVolumeVersions("test-volume", {})).toThrow(
        "Invalid volume-version format: test-volume",
      );
    });
  });

  describe("run command with --volume-version", () => {
    it("should pass single volume version to API", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--volume-version",
        "test-volume=abc123",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          volumeVersions: { "test-volume": "abc123" },
        }),
      );
    });

    it("should pass multiple volume versions to API", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--volume-version",
        "vol1=version1",
        "--volume-version",
        "vol2=version2",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          volumeVersions: { vol1: "version1", vol2: "version2" },
        }),
      );
    });

    it("should omit volumeVersions when not provided", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      // When not provided, volumeVersions should be undefined (not sent to API)
      expect(capturedBody?.volumeVersions).toBeUndefined();
    });
  });

  describe("continue command with --volume-version", () => {
    it("should pass volume versions to API", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "continue",
        testSessionId,
        "test prompt",
        "--volume-version",
        "data-volume=xyz789",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
          volumeVersions: { "data-volume": "xyz789" },
        }),
      );
    });

    it("should pass multiple volume versions to API", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "continue",
        testSessionId,
        "test prompt",
        "--volume-version",
        "vol1=v1",
        "--volume-version",
        "vol2=v2",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
          volumeVersions: { vol1: "v1", vol2: "v2" },
        }),
      );
    });
  });

  describe("resume command with --volume-version", () => {
    it("should pass volume versions to API", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "resume",
        testCheckpointId,
        "test prompt",
        "--volume-version",
        "config-volume=def456",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
          volumeVersions: { "config-volume": "def456" },
        }),
      );
    });

    it("should pass multiple volume versions to API", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "resume",
        testCheckpointId,
        "test prompt",
        "--volume-version",
        "vol1=v1",
        "--volume-version",
        "vol2=v2",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
          volumeVersions: { vol1: "v1", vol2: "v2" },
        }),
      );
    });
  });
});
