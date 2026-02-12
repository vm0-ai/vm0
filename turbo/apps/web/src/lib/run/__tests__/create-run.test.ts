import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestVolume,
  insertStalePendingRun,
  findTestRunRecord,
  findTestRunCallbacks,
  findTestRunByStatus,
} from "../../../__tests__/api-test-helpers";
import type { AgentComposeYaml } from "../../../types/agent-compose";
import { addPermission } from "../../agent/permission-service";
import { reloadEnv } from "../../../env";
import {
  createRun,
  type CreateRunParams,
  type CreateRunResult,
} from "../run-service";
import { isConcurrentRunLimit, isForbidden, isBadRequest } from "../../errors";

const context = testContext();

describe("createRun()", () => {
  let user: UserContext;
  let composeId: string;
  let versionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    composeId = compose.composeId;
    versionId = compose.versionId;
  });

  function baseParams(overrides?: Partial<CreateRunParams>): CreateRunParams {
    return {
      userId: user.userId,
      agentComposeVersionId: versionId,
      prompt: "Hello, world!",
      ...overrides,
    };
  }

  describe("Happy Path", () => {
    it("should create and dispatch a run successfully", async () => {
      const result: CreateRunResult = await createRun(baseParams());

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("running");
      expect(result.sandboxId).toBeDefined();
      expect(result.createdAt).toBeInstanceOf(Date);

      // Verify run record in DB
      const run = await findTestRunRecord(result.runId);

      expect(run).toBeDefined();
      expect(run!.status).toBe("running");
      expect(run!.userId).toBe(user.userId);
      expect(run!.prompt).toBe("Hello, world!");
      expect(run!.lastHeartbeatAt).toBeDefined();
    });

    it("should always set lastHeartbeatAt", async () => {
      const result = await createRun(baseParams());

      const run = await findTestRunRecord(result.runId);

      expect(run!.lastHeartbeatAt).not.toBeNull();
    });

    it("should store vars when provided", async () => {
      const vars = { MY_VAR: "value1", OTHER_VAR: "value2" };
      const result = await createRun(baseParams({ vars }));

      const run = await findTestRunRecord(result.runId);

      expect(run!.vars).toEqual(vars);
    });

    it("should store secretNames when secrets provided", async () => {
      const secrets = { API_KEY: "sk-123", DB_PASS: "pw" };
      const result = await createRun(baseParams({ secrets }));

      const run = await findTestRunRecord(result.runId);

      expect(run!.secretNames).toEqual(["API_KEY", "DB_PASS"]);
    });

    it("should set null scheduleId when not provided", async () => {
      const result = await createRun(baseParams());

      const run = await findTestRunRecord(result.runId);

      expect(run!.scheduleId).toBeNull();
    });
  });

  describe("Concurrent Run Limit", () => {
    it("should throw ConcurrentRunLimitError when limit reached", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Create first run
      await createRun(baseParams({ prompt: "First run" }));

      // Second run should fail
      await expect(
        createRun(baseParams({ prompt: "Second run" })),
      ).rejects.toSatisfy(isConcurrentRunLimit);
    });

    it("should allow unlimited runs when limit is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");
      reloadEnv();

      const run1 = await createRun(baseParams({ prompt: "Run 1" }));
      const run2 = await createRun(baseParams({ prompt: "Run 2" }));

      expect(run1.status).toBe("running");
      expect(run2.status).toBe("running");
    });

    it("should not count stale pending runs", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Insert a stale pending run (20 minutes old, beyond 15-min TTL)
      await insertStalePendingRun(user.userId, versionId);

      // New run should succeed
      const result = await createRun(baseParams());
      expect(result.status).toBe("running");
    });
  });

  describe("Permission Check", () => {
    it("should allow owner to access their own compose", async () => {
      // Default test compose is owned by the test user
      const result = await createRun(baseParams());
      expect(result.runId).toBeDefined();
    });

    it("should deny access for non-owner without permission", async () => {
      // Create a second user
      const otherUser = await context.setupUser({ prefix: "other-user" });

      await expect(
        createRun(
          baseParams({
            userId: otherUser.userId,
          }),
        ),
      ).rejects.toSatisfy(isForbidden);
    });

    it("should allow access for non-owner with public permission", async () => {
      const otherUser = await context.setupUser({ prefix: "perm-user" });

      // Grant public access directly via service (avoids API route auth check)
      await addPermission(composeId, "public", user.userId);

      const result = await createRun(
        baseParams({
          userId: otherUser.userId,
        }),
      );
      expect(result.runId).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should reject mutually exclusive checkpointId and sessionId", async () => {
      await expect(
        createRun(
          baseParams({
            checkpointId: "some-checkpoint",
            sessionId: "some-session",
          }),
        ),
      ).rejects.toSatisfy(isBadRequest);
    });

    it("should reject missing required template variables with checkEnv", async () => {
      // Create a compose with template variables
      const compose = await createTestCompose(uniqueId("var-agent"), {
        overrides: {
          environment: {
            MY_KEY: "${{ vars.REQUIRED_VAR }}",
            ANTHROPIC_API_KEY: "test-key",
          },
        },
      });

      // Vars validation only happens when checkEnv is enabled
      await expect(
        createRun(
          baseParams({
            agentComposeVersionId: compose.versionId,
            checkEnv: true, // Enable vars validation
            // No vars provided — should fail
          }),
        ),
      ).rejects.toSatisfy(isBadRequest);
    });
  });

  describe("Dispatch Failure", () => {
    it("should mark run as failed when dispatch throws", async () => {
      const { Sandbox } = await import("@e2b/code-interpreter");
      vi.mocked(Sandbox.create).mockRejectedValueOnce(
        new Error("Sandbox creation failed"),
      );

      await expect(createRun(baseParams())).rejects.toThrow(
        "Sandbox creation failed",
      );

      // Verify run is marked as failed in DB
      const run = await findTestRunByStatus("failed");

      expect(run).toBeDefined();
      expect(run!.error).toContain("Sandbox creation failed");
      expect(run!.completedAt).toBeDefined();
    });
  });

  describe("Callback Registration", () => {
    it("should register callbacks when provided", async () => {
      const callbacks = [
        {
          url: "https://example.com/callback",
          secret: "test-secret-123",
          payload: { channel: "C123", threadTs: "1234.5678" },
        },
      ];

      const result = await createRun(baseParams({ callbacks }));

      // Verify callback record in DB
      const callbackRecords = await findTestRunCallbacks(result.runId);

      expect(callbackRecords).toHaveLength(1);
      expect(callbackRecords[0]!.url).toBe("https://example.com/callback");
      expect(callbackRecords[0]!.encryptedSecret).toBeDefined();
      expect(callbackRecords[0]!.payload).toEqual({
        channel: "C123",
        threadTs: "1234.5678",
      });
    });
  });

  describe("Optional Volumes", () => {
    /**
     * Helper to create a compose with volume configuration
     */
    async function createComposeWithVolumes(
      agentName: string,
      volumes: AgentComposeYaml["volumes"],
      agentVolumes: string[],
    ) {
      const config: AgentComposeYaml = {
        version: "1.0",
        agents: {
          [agentName]: {
            image: "vm0/claude-code:latest",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
            environment: { ANTHROPIC_API_KEY: "test-api-key" },
            volumes: agentVolumes,
          },
        },
        volumes,
      };

      // Use direct DB insert via POST /api/agent/composes
      const { POST: createComposeRoute } = await import(
        "../../../../app/api/agent/composes/route"
      );
      const { createTestRequest } = await import(
        "../../../__tests__/api-test-helpers"
      );

      const request = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: config }),
        },
      );
      const response = await createComposeRoute(request);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          `Failed to create compose: ${error.error?.message || response.status}`,
        );
      }
      return response.json() as Promise<{
        composeId: string;
        versionId: string;
      }>;
    }

    it("should succeed when optional volume exists", async () => {
      const volumeName = uniqueId("vol");
      // Create the volume first
      await createTestVolume(volumeName);

      // Create compose with optional volume
      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: volumeName,
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      expect(result.status).toBe("running");
    });

    it("should succeed when optional volume does not exist (skip silently)", async () => {
      // Create compose with optional volume that doesn't exist
      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: "nonexistent-volume",
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      // Should succeed - optional volume is silently skipped
      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      expect(result.status).toBe("running");
    });

    it("should fail when required volume does not exist", async () => {
      // Create compose with required volume (optional: false or not specified)
      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: "nonexistent-volume",
            version: "latest",
            // optional defaults to false
          },
        },
        ["mydata:/data"],
      );

      // Should fail - required volume doesn't exist
      await expect(
        createRun(baseParams({ agentComposeVersionId: compose.versionId })),
      ).rejects.toThrow(/not found/);
    });

    it("should skip optional volume during checkpoint resume when it was skipped originally", async () => {
      const volumeName = uniqueId("vol");

      // Create compose with optional volume
      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: volumeName,
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      // Simulate checkpoint resume scenario:
      // volumeVersions is provided but does NOT include the optional volume
      // (meaning it was skipped at checkpoint time)
      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          // Empty volumeVersions means no volumes were mounted at checkpoint
          volumeVersions: {},
        }),
      );

      // Even if we now create the volume, it should still succeed
      // because the checkpoint resume should skip this optional volume
      expect(result.status).toBe("running");
    });

    it("should mount optional volume in session/continue when it now exists (no volumeVersions)", async () => {
      const volumeName = uniqueId("vol");
      // Create the volume first
      await createTestVolume(volumeName);

      // Create compose with optional volume
      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: volumeName,
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      // Session/Continue scenario: volumeVersions is NOT provided (undefined)
      // This means we should use current config and mount if volume exists
      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          // No volumeVersions - use latest state
        }),
      );

      expect(result.status).toBe("running");
    });

    it("should succeed with mixed volumes (required exists, optional missing)", async () => {
      const requiredVolumeName = uniqueId("required-vol");
      // Create only the required volume
      await createTestVolume(requiredVolumeName);

      // Create compose with both required and optional volumes
      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          requiredData: {
            name: requiredVolumeName,
            version: "latest",
            // optional defaults to false (required)
          },
          optionalData: {
            name: "nonexistent-optional-volume",
            version: "latest",
            optional: true,
          },
        },
        ["requiredData:/required", "optionalData:/optional"],
      );

      // Should succeed - required volume exists, optional is skipped
      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      expect(result.status).toBe("running");
    });
  });
});
