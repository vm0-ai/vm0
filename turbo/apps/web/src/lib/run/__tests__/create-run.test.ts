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
  createTestOrgModelProvider,
  insertStalePendingRun,
  findTestRunRecord,
  findTestRunCallbacks,
  findTestStorage,
  findTestRunnerJobEntry,
} from "../../../__tests__/api-test-helpers";
import { POST as checkpointWebhook } from "../../../../app/api/webhooks/agent/checkpoints/route";
import type { AgentComposeYaml } from "../../../types/agent-compose";
import { reloadEnv } from "../../../env";
import {
  createRun,
  type CreateRunParams,
  type CreateRunResult,
} from "../run-service";
import { isForbidden, isBadRequest } from "../../errors";
import { POST as createComposeRoute } from "../../../../app/api/agent/composes/route";
import { POST as pollRoute } from "../../../../app/api/runners/poll/route";
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
      orgId: user.orgId,
      ...overrides,
    };
  }

  describe("Happy Path", () => {
    it("should create and dispatch a run successfully", async () => {
      const result: CreateRunResult = await createRun(baseParams());

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
      expect(result.createdAt).toBeInstanceOf(Date);

      // Verify run record in DB
      const run = await findTestRunRecord(result.runId);

      expect(run).toBeDefined();
      expect(run!.status).toBe("pending");
      expect(run!.userId).toBe(user.userId);
      expect(run!.prompt).toBe("Hello, world!");
      expect(run!.lastHeartbeatAt).toBeDefined();
    });

    it("should store appendSystemPrompt when provided", async () => {
      const result = await createRun(
        baseParams({ appendSystemPrompt: "Your name is Aria." }),
      );

      const run = await findTestRunRecord(result.runId);

      expect(run!.appendSystemPrompt).toBe("Your name is Aria.");
    });

    it("should default appendSystemPrompt to null when not provided", async () => {
      const result = await createRun(baseParams());

      const run = await findTestRunRecord(result.runId);

      expect(run!.appendSystemPrompt).toBeNull();
    });

    it("should propagate appendSystemPrompt through runner job dispatch", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const result = await createRun(
        baseParams({ appendSystemPrompt: "Your name is Aria." }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run!.appendSystemPrompt).toBe("Your name is Aria.");

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
    });

    it("should always set lastHeartbeatAt", async () => {
      const result = await createRun(baseParams());

      const run = await findTestRunRecord(result.runId);

      expect(run!.lastHeartbeatAt).not.toBeNull();
    });

    it("should refresh lastHeartbeatAt during pipeline", async () => {
      const result = await createRun(baseParams());

      const run = await findTestRunRecord(result.runId);

      // The mid-pipeline heartbeat UPDATE runs after generateSandboxToken +
      // buildContext, so lastHeartbeatAt must be strictly later than
      // createdAt (which is set by the initial INSERT's defaultNow()).
      expect(run!.lastHeartbeatAt!.getTime()).toBeGreaterThan(
        run!.createdAt.getTime(),
      );
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
        baseParams({ prompt: "Pro run 1", orgTier: "pro" }),
      );
      const run2 = await createRun(
        baseParams({ prompt: "Pro run 2", orgTier: "pro" }),
      );

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
    });

    it("should queue 3rd concurrent run for pro tier", async () => {
      await createRun(baseParams({ prompt: "Pro run 1", orgTier: "pro" }));
      await createRun(baseParams({ prompt: "Pro run 2", orgTier: "pro" }));

      const run3 = await createRun(
        baseParams({ prompt: "Pro run 3", orgTier: "pro" }),
      );
      expect(run3.status).toBe("queued");
    });

    it("should allow multiple concurrent runs for max tier", async () => {
      // Create 3 concurrent runs to verify max tier allows more than pro tier (which allows 2)
      const run1 = await createRun(
        baseParams({ prompt: "Max run 1", orgTier: "max" }),
      );
      const run2 = await createRun(
        baseParams({ prompt: "Max run 2", orgTier: "max" }),
      );
      const run3 = await createRun(
        baseParams({ prompt: "Max run 3", orgTier: "max" }),
      );

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
      expect(run3.status).toBe("pending");
    });

    it("should allow unlimited runs when CONCURRENT_RUN_LIMIT_CAP is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      const run1 = await createRun(baseParams({ prompt: "Run 1" }));
      const run2 = await createRun(baseParams({ prompt: "Run 2" }));

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
    });

    it("should not count stale pending runs", async () => {
      // Free tier limit is 1; stale pending run should not count
      await insertStalePendingRun(user.userId, versionId);

      const result = await createRun(baseParams());
      expect(result.status).toBe("pending");
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

    it("should enforce limit per-org, not per-user", async () => {
      // Create a run in the default org (fills its free-tier slot)
      await createRun(baseParams({ prompt: "Org 1 run" }));

      // Create a second user with a different org
      const otherUser = await context.setupUser({ prefix: "org-user" });
      const otherCompose = await createTestCompose(uniqueId("other-agent"));

      // Run in the other org should succeed (separate org, separate limit)
      const result = await createRun({
        userId: otherUser.userId,
        agentComposeVersionId: otherCompose.versionId,
        prompt: "Org 2 run",
        orgId: otherUser.orgId,
      });
      expect(result.status).toBe("pending");
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
      expect(result.status).toBe("pending");
    });

    it("should succeed when memory already exists (idempotent)", async () => {
      // Allow concurrent runs for this test
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      const memoryName = uniqueId("existing-mem");
      // First run creates the memory
      await createRun(baseParams({ memoryName }));

      // Second run should also succeed (idempotent)
      const result = await createRun(
        baseParams({ memoryName, prompt: "second run" }),
      );
      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should accept memoryName and dispatch successfully", async () => {
      const result = await createRun(baseParams({ memoryName: "my-memory" }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should restore memoryName from session in continue flow", async () => {
      // Allow concurrent runs for this test
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
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
      const continueResult = await createRun(
        baseParams({
          sessionId: agentSessionId,
          prompt: "Continue prompt",
        }),
      );

      expect(continueResult.runId).toBeDefined();
      expect(continueResult.status).toBe("pending");
    });
  });

  describe("Auto-Create Artifact", () => {
    it("should succeed when artifact does not exist (auto-create)", async () => {
      const artifactName = uniqueId("new-art");
      const result = await createRun(baseParams({ artifactName }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should succeed when artifact already exists", async () => {
      const artifactName = uniqueId("existing-art");
      await createTestArtifact(artifactName);

      const result = await createRun(baseParams({ artifactName }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
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
            framework: "claude-code",
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

      expect(result.status).toBe("pending");
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

      expect(result.status).toBe("pending");
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
      expect(result.status).toBe("pending");
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

      expect(result.status).toBe("pending");
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

      expect(result.status).toBe("pending");
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

    it("should use default executor when RUNNER_DEFAULT_GROUP is not set", async () => {
      // RUNNER_DEFAULT_GROUP is not set by default in test env
      mockClerk({ userId: user.userId, email: "team@vm0.ai" });

      const result = await createRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should mark run as failed when runner group org validation fails", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "nonexistent-org/default");
      reloadEnv();

      mockClerk({ userId: user.userId, email: "user@example.com" });

      let caughtError: unknown;
      try {
        await createRun(baseParams());
      } catch (error: unknown) {
        caughtError = error;
      }

      // Dispatch failure should throw a ForbiddenError
      expect(caughtError).toSatisfy(isForbidden);

      // The error should carry runId metadata (RunDispatchError)
      expect(caughtError).toHaveProperty("runId");
      const runId = (caughtError as { runId: string }).runId;

      // Verify the run is marked as "failed" in the database
      const run = await findTestRunRecord(runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("failed");
      expect(run!.error).toMatch(/nonexistent-org/);
    });
  });

  describe("Experimental Profile", () => {
    it("should store profile in runner job queue when experimental_profile is set", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const compose = await createTestCompose(uniqueId("profile-agent"), {
        overrides: { experimental_profile: "vm0/default" },
      });

      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.profile).toBe("vm0/default");
      expect(job!.executionContext.experimentalProfile).toBe("vm0/default");
    });

    it("should default to vm0/default when experimental_profile is not set", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const result = await createRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.profile).toBe("vm0/default");
      expect(job!.executionContext.experimentalProfile).toBe("vm0/default");
    });

    it("should filter jobs by profiles array in poll endpoint", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      // Create two runs — one with default profile, one with explicit profile
      const browserCompose = await createTestCompose(
        uniqueId("browser-agent"),
        { overrides: { experimental_profile: "vm0/default" } },
      );
      await createRun(baseParams({ prompt: "default job" }));
      await createRun(
        baseParams({
          prompt: "browser job",
          agentComposeVersionId: browserCompose.versionId,
        }),
      );

      // Poll with profiles filter for a non-existent profile — should find nothing
      const officialToken = `vm0_official_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
      const emptyPoll = await pollRoute(
        createTestRequest("http://localhost:3000/api/runners/poll", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${officialToken}`,
          },
          body: JSON.stringify({
            group: "vm0/production",
            profiles: ["vm0/nonexistent"],
          }),
        }),
      );
      const emptyResult = await emptyPoll.json();
      expect(emptyResult.job).toBeNull();

      // Poll without profiles filter — should find a job
      const allPoll = await pollRoute(
        createTestRequest("http://localhost:3000/api/runners/poll", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${officialToken}`,
          },
          body: JSON.stringify({ group: "vm0/production" }),
        }),
      );
      const allResult = await allPoll.json();
      expect(allResult.job).not.toBeNull();
      expect(allResult.job.experimentalProfile).toBe("vm0/default");
    });

    it("should reject unknown profile with 400", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const compose = await createTestCompose(uniqueId("bad-profile"), {
        overrides: { experimental_profile: "vm0/unknown" },
      });

      await expect(
        createRun(baseParams({ agentComposeVersionId: compose.versionId })),
      ).rejects.toSatisfy(isBadRequest);
    });
  });

  describe("Org Resolution for Storage", () => {
    it("should use runtime orgId for artifact/memory storage when orgId is provided", async () => {
      // Create a second org and make the user a member
      const orgCompose = await context.createAgentCompose(user.userId, {
        name: uniqueId("org-agent"),
      });
      const orgClerkOrgId = orgCompose.orgId;

      // Use the default compose but pass org for storage resolution
      const result = await createRun(
        baseParams({
          artifactName: "artifact",
          memoryName: "memory",
          orgId: orgClerkOrgId,
          orgSlug: uniqueId("org"), // slug used for S3 prefix (mocked in tests)
        }),
      );

      expect(result.status).toBe("pending");

      // Verify the run record was created
      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();

      // Verify artifact storage was created in the specified org (not user's default org)
      const artifact = await findTestStorage(
        orgClerkOrgId,
        "artifact",
        "artifact",
      );
      expect(artifact).toBeDefined();
      expect(artifact!.userId).toBe(user.userId);

      // Verify memory storage was created in the specified org
      const memory = await findTestStorage(orgClerkOrgId, "memory", "memory");
      expect(memory).toBeDefined();
      expect(memory!.userId).toBe(user.userId);
    });

    it("should use default org for storage when orgId is not provided", async () => {
      const compose = await createTestCompose(uniqueId("agent"));

      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          artifactName: "artifact",
          memoryName: "memory",
        }),
      );

      expect(result.status).toBe("pending");

      // Verify artifact storage was created in user's default org
      const artifact = await findTestStorage(
        user.orgId,
        "artifact",
        "artifact",
      );
      expect(artifact).toBeDefined();
      expect(artifact!.userId).toBe(user.userId);

      // Verify memory storage was created in user's default org
      const memory = await findTestStorage(user.orgId, "memory", "memory");
      expect(memory).toBeDefined();
      expect(memory!.userId).toBe(user.userId);
    });
  });

  describe("Model Provider Env Var Injection", () => {
    it("should inject Vercel AI Gateway model provider env vars into sandbox environment", async () => {
      // Create compose without default ANTHROPIC_API_KEY so auto-injection is triggered
      const noKeyCompose = await createTestCompose(uniqueId("no-key-agent"), {
        skipDefaultApiKey: true,
      });

      await createTestOrgModelProvider("vercel-ai-gateway", "test-gateway-key");

      const result = await createRun(
        baseParams({ agentComposeVersionId: noKeyCompose.versionId }),
      );

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Model provider token is replaced with placeholder (firewall gateway protects it)
      expect(job!.executionContext.environment).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: "sk-vm0placeholder000000000000000000",
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.6",
      });
    });

    it("should store resolved model provider on run record when using org default", async () => {
      const noKeyCompose = await createTestCompose(uniqueId("no-key-agent"), {
        skipDefaultApiKey: true,
      });

      await createTestOrgModelProvider("vercel-ai-gateway", "test-gateway-key");

      const result = await createRun(
        baseParams({ agentComposeVersionId: noKeyCompose.versionId }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run!.modelProvider).toBe("vercel-ai-gateway");
    });

    it("should preserve explicit model provider on run record", async () => {
      const noKeyCompose = await createTestCompose(uniqueId("no-key-agent"), {
        skipDefaultApiKey: true,
      });

      await createTestOrgModelProvider("vercel-ai-gateway", "test-gateway-key");

      const result = await createRun(
        baseParams({
          agentComposeVersionId: noKeyCompose.versionId,
          modelProvider: "vercel-ai-gateway",
        }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run!.modelProvider).toBe("vercel-ai-gateway");
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
      await createTestConnector({
        type: "figma",
        authMethod: "api-token",
        secretName: "FIGMA_TOKEN",
        accessToken: "figd_test_secret_123",
      });

      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");

      // Verify the runner job queue entry contains the injected secret
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        FIGMA_TOKEN: "figd_test_secret_123",
      });
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
      await createTestConnector({
        type: "productlane",
        authMethod: "api-token",
        secretName: "PRODUCTLANE_TOKEN",
        accessToken: "pl_test_secret_789",
      });

      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");

      // Verify the runner job queue entry contains the injected secret
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        PRODUCTLANE_TOKEN: "pl_test_secret_789",
      });
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
      await createTestConnector({
        type: "github",
        authMethod: "oauth",
        accessToken: "ghp_oauth_test_456",
      });

      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");

      // Verify the runner job queue entry contains the injected secret
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        GH_TOKEN: "ghp_oauth_test_456",
      });
    });
  });
});
