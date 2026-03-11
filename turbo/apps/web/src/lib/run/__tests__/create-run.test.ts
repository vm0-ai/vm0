import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestConnector,
  createTestVolume,
  createTestArtifact,
  createTestRequest,
  createTestSandboxToken,
  createTestRun,
  insertStalePendingRun,
  findTestRunRecord,
  findTestRunCallbacks,
  findTestRunsByUserAndPrompt,
  findTestStorage,
} from "../../../__tests__/api-test-helpers";
import { POST as checkpointWebhook } from "../../../../app/api/webhooks/agent/checkpoints/route";
import type { AgentComposeYaml } from "../../../types/agent-compose";
import { addPermission } from "../../agent/permission-service";
import { reloadEnv } from "../../../env";
import {
  createRun,
  type CreateRunParams,
  type CreateRunResult,
} from "../run-service";
import { isForbidden, isBadRequest } from "../../errors";
import { Sandbox } from "@e2b/code-interpreter";
import { POST as createComposeRoute } from "../../../../app/api/agent/composes/route";
import { mockClerk } from "../../../__tests__/clerk-mock";

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
    it("should enqueue run when free tier limit reached", async () => {
      // Free tier (default) allows only 1 concurrent run
      await createRun(baseParams({ prompt: "First run" }));

      // Second run should be queued (not rejected)
      const result = await createRun(baseParams({ prompt: "Second run" }));

      expect(result.status).toBe("queued");
      expect(result.runId).toBeDefined();

      // Verify queued run record in DB
      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("queued");
      expect(run!.prompt).toBe("Second run");
    });

    it("should allow 2 concurrent runs for pro tier", async () => {
      const run1 = await createRun(
        baseParams({ prompt: "Pro run 1", scopeTier: "pro" }),
      );
      const run2 = await createRun(
        baseParams({ prompt: "Pro run 2", scopeTier: "pro" }),
      );

      expect(run1.status).toBe("running");
      expect(run2.status).toBe("running");
    });

    it("should queue 3rd concurrent run for pro tier", async () => {
      await createRun(baseParams({ prompt: "Pro run 1", scopeTier: "pro" }));
      await createRun(baseParams({ prompt: "Pro run 2", scopeTier: "pro" }));

      const run3 = await createRun(
        baseParams({ prompt: "Pro run 3", scopeTier: "pro" }),
      );
      expect(run3.status).toBe("queued");
    });

    it("should allow multiple concurrent runs for max tier", async () => {
      // Create 3 concurrent runs to verify max tier allows more than pro tier (which allows 2)
      const run1 = await createRun(
        baseParams({ prompt: "Max run 1", scopeTier: "max" }),
      );
      const run2 = await createRun(
        baseParams({ prompt: "Max run 2", scopeTier: "max" }),
      );
      const run3 = await createRun(
        baseParams({ prompt: "Max run 3", scopeTier: "max" }),
      );

      expect(run1.status).toBe("running");
      expect(run2.status).toBe("running");
      expect(run3.status).toBe("running");
    });

    it("should allow unlimited runs when CONCURRENT_RUN_LIMIT is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");
      reloadEnv();

      const run1 = await createRun(baseParams({ prompt: "Run 1" }));
      const run2 = await createRun(baseParams({ prompt: "Run 2" }));

      expect(run1.status).toBe("running");
      expect(run2.status).toBe("running");
    });

    it("should not count stale pending runs", async () => {
      // Free tier limit is 1; stale pending run should not count
      await insertStalePendingRun(user.userId, versionId);

      const result = await createRun(baseParams());
      expect(result.status).toBe("running");
    });

    it("should enqueue second run when concurrency limit reached", async () => {
      // Free tier limit is 1 — advisory lock should serialize them
      const results = await Promise.allSettled([
        createRun(baseParams({ prompt: "Concurrent A" })),
        createRun(baseParams({ prompt: "Concurrent B" })),
      ]);

      // Both should succeed: one runs, one gets queued
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(2);

      const statuses = fulfilled.map(
        (r) => r.status === "fulfilled" && r.value.status,
      );
      expect(statuses).toContain("queued");
    });

    it("should enforce limit per-scope, not per-user", async () => {
      // Create a run in the default scope (fills its free-tier slot)
      await createRun(baseParams({ prompt: "Scope 1 run" }));

      // Create a second user with a different scope
      const otherUser = await context.setupUser({ prefix: "scope-user" });
      const otherCompose = await createTestCompose(uniqueId("other-agent"));

      // Run in the other scope should succeed (separate scope, separate limit)
      const result = await createRun({
        userId: otherUser.userId,
        agentComposeVersionId: otherCompose.versionId,
        prompt: "Scope 2 run",
      });
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
      vi.mocked(Sandbox.create).mockRejectedValueOnce(
        new Error("Sandbox creation failed"),
      );

      await expect(createRun(baseParams())).rejects.toThrow(
        "Sandbox creation failed",
      );

      // Verify run is marked as failed in DB
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "Hello, world!",
      );
      const run = runs.find((r) => r.status === "failed");

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

  describe("Memory", () => {
    it("should auto-create memory storage on first run", async () => {
      const memoryName = uniqueId("new-mem");
      const result = await createRun(baseParams({ memoryName }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("running");

      // Verify sandbox was called with full memory env vars including VERSION_ID
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      const sandboxOptions = createCall![1] as {
        envs?: Record<string, string>;
      };
      expect(sandboxOptions.envs?.VM0_MEMORY_NAME).toBe(memoryName);
      expect(sandboxOptions.envs?.VM0_MEMORY_VERSION_ID).toBeDefined();
      expect(sandboxOptions.envs?.VM0_MEMORY_DRIVER).toBe("vas");
    });

    it("should succeed when memory already exists (idempotent)", async () => {
      // Allow concurrent runs for this test
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");
      reloadEnv();

      const memoryName = uniqueId("existing-mem");
      // First run creates the memory
      await createRun(baseParams({ memoryName }));

      // Second run should also succeed (idempotent)
      const result = await createRun(
        baseParams({ memoryName, prompt: "second run" }),
      );
      expect(result.runId).toBeDefined();
      expect(result.status).toBe("running");
    });

    it("should accept memoryName and dispatch successfully", async () => {
      const result = await createRun(baseParams({ memoryName: "my-memory" }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("running");
    });

    it("should restore memoryName from session in continue flow", async () => {
      // Allow concurrent runs for this test
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");
      reloadEnv();

      // Step 1: Create a run and checkpoint with memorySnapshot
      const { runId } = await createTestRun(composeId, "Initial run");
      const sandboxToken = await createTestSandboxToken(user.userId, runId);

      const checkpointRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sandboxToken}`,
          },
          body: JSON.stringify({
            runId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-for-continue",
            cliAgentSessionHistory: JSON.stringify([]),
            memorySnapshot: {
              memoryName: "restored-memory",
              memoryVersion: "v1",
            },
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);

      const { agentSessionId } = (await checkpointResponse.json()) as {
        agentSessionId: string;
      };

      // Step 2: Continue from session WITHOUT specifying memoryName
      vi.mocked(Sandbox.create).mockClear();
      const continueResult = await createRun(
        baseParams({
          sessionId: agentSessionId,
          prompt: "Continue prompt",
        }),
      );

      expect(continueResult.runId).toBeDefined();
      expect(continueResult.status).toBe("running");

      // Step 3: Verify Sandbox.create was called with VM0_MEMORY_NAME
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      const sandboxOptions = createCall![1] as {
        envs?: Record<string, string>;
      };
      expect(sandboxOptions.envs?.VM0_MEMORY_NAME).toBe("restored-memory");
    });
  });

  describe("Auto-Create Artifact", () => {
    it("should succeed when artifact does not exist (auto-create)", async () => {
      const artifactName = uniqueId("new-art");
      const result = await createRun(baseParams({ artifactName }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("running");
    });

    it("should succeed when artifact already exists", async () => {
      const artifactName = uniqueId("existing-art");
      await createTestArtifact(artifactName);

      const result = await createRun(baseParams({ artifactName }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("running");
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

  describe("Runner Default Group Routing", () => {
    it("should route all users to runner when RUNNER_DEFAULT_GROUP is set", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      mockClerk({ userId: user.userId, email: "user@example.com" });

      const result = await createRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should fall back to E2B when RUNNER_DEFAULT_GROUP is not set", async () => {
      // RUNNER_DEFAULT_GROUP is not set by default in test env
      mockClerk({ userId: user.userId, email: "team@vm0.ai" });

      const result = await createRun(baseParams());

      expect(result.status).toBe("running");
    });
  });

  describe("Scope Resolution for Storage", () => {
    it("should use runtime scopeId for artifact/memory storage when scopeId is provided", async () => {
      // Create a second scope (org scope) and make the user a member
      const orgCompose = await context.createAgentCompose(user.userId, {
        name: uniqueId("org-agent"),
      });
      const orgScopeId = orgCompose.scopeId;
      const orgClerkOrgId = orgCompose.clerkOrgId;

      // Use the default compose but pass org scope for storage resolution
      const result = await createRun(
        baseParams({
          artifactName: "artifact",
          memoryName: "memory",
          scopeId: orgScopeId,
          scopeSlug: uniqueId("org"), // slug used for S3 prefix (mocked in tests)
        }),
      );

      expect(result.status).toBe("running");

      // Verify the run record uses the org scope
      const run = await findTestRunRecord(result.runId);
      expect(run!.scopeId).toBe(orgScopeId);

      // Verify artifact storage was created in the org scope (not user's default scope)
      const artifact = await findTestStorage(
        orgClerkOrgId,
        "artifact",
        "artifact",
      );
      expect(artifact).toBeDefined();
      expect(artifact!.userId).toBe(user.userId);

      // Verify memory storage was created in the org scope
      const memory = await findTestStorage(orgClerkOrgId, "memory", "memory");
      expect(memory).toBeDefined();
      expect(memory!.userId).toBe(user.userId);
    });

    it("should use default scope for storage when scopeId is not provided", async () => {
      const compose = await createTestCompose(uniqueId("agent"));

      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          artifactName: "artifact",
          memoryName: "memory",
        }),
      );

      expect(result.status).toBe("running");

      // Verify artifact storage was created in user's default scope
      const artifact = await findTestStorage(
        user.clerkOrgId,
        "artifact",
        "artifact",
      );
      expect(artifact).toBeDefined();
      expect(artifact!.userId).toBe(user.userId);

      // Verify memory storage was created in user's default scope
      const memory = await findTestStorage(user.clerkOrgId, "memory", "memory");
      expect(memory).toBeDefined();
      expect(memory!.userId).toBe(user.userId);
    });
  });

  describe("Connector Secret Injection", () => {
    it("should inject api-token connector secret into sandbox environment", async () => {
      // Create a compose that references the secret via ${{ secrets.FIGMA_TOKEN }}
      const compose = await createTestCompose(uniqueId("api-token-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            FIGMA_TOKEN: "${{ secrets.FIGMA_TOKEN }}",
          },
        },
      });

      // Create a figma connector with api-token auth and secret stored under target name
      await createTestConnector(user.scopeId, {
        type: "figma",
        authMethod: "api-token",
        secretName: "FIGMA_TOKEN",
        accessToken: "figd_test_secret_123",
      });

      await createRun(baseParams({ agentComposeVersionId: compose.versionId }));

      // Verify the secret was injected into sandbox environment
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      const sandboxOptions = createCall![1] as {
        envs?: Record<string, string>;
      };
      expect(sandboxOptions.envs?.FIGMA_TOKEN).toBe("figd_test_secret_123");
    });

    it("should inject api-token-only connector secret (no environmentMapping) into sandbox environment", async () => {
      // Productlane has empty environmentMapping — secret is resolved purely
      // from user secrets, not via connector environmentMapping.
      const compose = await createTestCompose(
        uniqueId("api-token-only-agent"),
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-api-key",
              PRODUCTLANE_TOKEN: "${{ secrets.PRODUCTLANE_TOKEN }}",
            },
          },
        },
      );

      // Store secret as a user secret (api-token connector path)
      await createTestConnector(user.scopeId, {
        type: "productlane",
        authMethod: "api-token",
        secretName: "PRODUCTLANE_TOKEN",
        accessToken: "pl_test_secret_789",
      });

      await createRun(baseParams({ agentComposeVersionId: compose.versionId }));

      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      const sandboxOptions = createCall![1] as {
        envs?: Record<string, string>;
      };
      expect(sandboxOptions.envs?.PRODUCTLANE_TOKEN).toBe("pl_test_secret_789");
    });

    it("should inject oauth connector secret via environmentMapping into sandbox environment", async () => {
      // Create a compose that references the mapped secret name
      const compose = await createTestCompose(uniqueId("oauth-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            GH_TOKEN: "${{ secrets.GH_TOKEN }}",
          },
        },
      });

      // Create a github connector with oauth auth via callback route
      await createTestConnector(user.scopeId, {
        type: "github",
        authMethod: "oauth",
        accessToken: "ghp_oauth_test_456",
      });

      await createRun(baseParams({ agentComposeVersionId: compose.versionId }));

      // Verify the mapped secret was injected into sandbox environment
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      const sandboxOptions = createCall![1] as {
        envs?: Record<string, string>;
      };
      expect(sandboxOptions.envs?.GH_TOKEN).toBe("ghp_oauth_test_456");
    });
  });
});
