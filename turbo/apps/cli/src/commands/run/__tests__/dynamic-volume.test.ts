import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createMockChildProcess } from "../../../mocks/spawn-helpers";
import { runCommand } from "../index";
import { parseMount, collectMounts } from "../shared";
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
 * CLI Command Integration Tests for --volume option
 *
 * Tests the --volume parameter parsing and API transmission for:
 * - run command
 * - continue command
 * - resume command
 *
 * The actual dynamic volume mount behavior is tested via E2E tests
 * (see e2e/tests/03-runner/t49-vm0-dynamic-volume.bats).
 */
describe("--volume option", () => {
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
    mockSpawn.mockImplementation(() => {
      return createMockChildProcess(0) as never;
    });
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("parseMount", () => {
    it("should parse name:/path format", () => {
      const result = parseMount("my-data:/mnt/data", "volume");
      expect(result).toEqual({ name: "my-data", mountPath: "/mnt/data" });
    });

    it("should parse name:version:/path format", () => {
      const result = parseMount("my-data:abc123:/mnt/data", "volume");
      expect(result).toEqual({
        name: "my-data",
        version: "abc123",
        mountPath: "/mnt/data",
      });
    });

    it("should reject input with no mount path", () => {
      expect(() => {
        return parseMount("my-data", "volume");
      }).toThrow(
        "Invalid volume format: my-data (expected name:/path or name:version:/path)",
      );
    });

    it("should reject empty name", () => {
      expect(() => {
        return parseMount(":/mnt/data", "volume");
      }).toThrow("Invalid volume format: :/mnt/data (name cannot be empty)");
    });

    it("should reject mount path not starting with /", () => {
      expect(() => {
        return parseMount("my-data:abc123:not-a-path", "volume");
      }).toThrow("Invalid volume mount path: not-a-path (must start with /)");
    });

    it("should reject empty version in 3-part format", () => {
      expect(() => {
        return parseMount("my-data::/mnt/data", "volume");
      }).toThrow(
        "Invalid volume format: my-data::/mnt/data (version cannot be empty)",
      );
    });

    it("should reject too many parts", () => {
      expect(() => {
        return parseMount("a:b:c:d", "volume");
      }).toThrow(
        "Invalid volume format: a:b:c:d (expected name:/path or name:version:/path)",
      );
    });
  });

  describe("collectMounts", () => {
    it("should accumulate volumes into array", () => {
      let result = collectMounts("vol-a:/mnt/a", []);
      result = collectMounts("vol-b:/mnt/b", result);
      expect(result).toEqual([
        { name: "vol-a", mountPath: "/mnt/a" },
        { name: "vol-b", mountPath: "/mnt/b" },
      ]);
    });

    it("should start with empty array", () => {
      const result = collectMounts("vol:/mnt/vol", []);
      expect(result).toEqual([{ name: "vol", mountPath: "/mnt/vol" }]);
    });
  });

  describe("run command with --volume", () => {
    it("should pass single volume to API as additionalVolumes", async () => {
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
        "--volume",
        "my-data:/mnt/data",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          additionalVolumes: [{ name: "my-data", mountPath: "/mnt/data" }],
        }),
      );
    });

    it("should pass multiple volumes to API", async () => {
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
        "--volume",
        "vol-a:/mnt/a",
        "--volume",
        "vol-b:v2:/mnt/b",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          additionalVolumes: [
            { name: "vol-a", mountPath: "/mnt/a" },
            { name: "vol-b", version: "v2", mountPath: "/mnt/b" },
          ],
        }),
      );
    });

    it("should omit additionalVolumes when not provided", async () => {
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

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(capturedBody?.additionalVolumes).toBeUndefined();
    });

    it("should work independently with --volume-version", async () => {
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
        "--volume",
        "dynamic-vol:/mnt/dynamic",
        "--volume-version",
        "compose-vol=v2",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          additionalVolumes: [
            { name: "dynamic-vol", mountPath: "/mnt/dynamic" },
          ],
          volumeVersions: { "compose-vol": "v2" },
        }),
      );
    });
  });

  describe("continue command with --volume", () => {
    it("should pass volumes to API as additionalVolumes", async () => {
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
        "--volume",
        "extra:/mnt/extra",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
          additionalVolumes: [{ name: "extra", mountPath: "/mnt/extra" }],
        }),
      );
    });

    it("should omit additionalVolumes when not provided", async () => {
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
        "continue",
        testSessionId,
        "test prompt",
      ]);

      expect(capturedBody?.additionalVolumes).toBeUndefined();
    });
  });

  describe("resume command with --volume", () => {
    it("should pass volumes to API as additionalVolumes", async () => {
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
        "--volume",
        "extra:v1:/mnt/extra",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
          additionalVolumes: [
            { name: "extra", version: "v1", mountPath: "/mnt/extra" },
          ],
        }),
      );
    });

    it("should pass multiple volumes to API", async () => {
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
        "--volume",
        "vol-a:/mnt/a",
        "--volume",
        "vol-b:/mnt/b",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
          additionalVolumes: [
            { name: "vol-a", mountPath: "/mnt/a" },
            { name: "vol-b", mountPath: "/mnt/b" },
          ],
        }),
      );
    });

    it("should work independently with --volume-version", async () => {
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
        "--volume",
        "dynamic:/mnt/dynamic",
        "--volume-version",
        "compose-vol=v3",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
          additionalVolumes: [{ name: "dynamic", mountPath: "/mnt/dynamic" }],
          volumeVersions: { "compose-vol": "v3" },
        }),
      );
    });
  });
});
