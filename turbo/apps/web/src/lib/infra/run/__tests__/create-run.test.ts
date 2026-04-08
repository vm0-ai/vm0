import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestVolume,
  createTestArtifact,
  createTestRequest,
  createTestSandboxToken,
  createTestRun,
  createCliRun,
  type CliRunParams,
  insertStalePendingRun,
  findTestRunRecord,
  findTestRunCallbacks,
  findTestStorage,
  findTestRunnerJobEntry,
  updateOrgTier,
} from "../../../../__tests__/api-test-helpers";
import { POST as checkpointWebhook } from "../../../../../app/api/webhooks/agent/checkpoints/route";
import type { AgentComposeYaml } from "../../agent-compose/types";
import { reloadEnv } from "../../../../env";
import type { CreateRunResult } from "../run-service";
import {
  isForbidden,
  isBadRequest,
  isConcurrentRunLimit,
} from "../../../shared/errors";
import { POST as createComposeRoute } from "../../../../../app/api/agent/composes/route";
import { POST as pollRoute } from "../../../../../app/api/runners/poll/route";
import { mockClerk } from "../../../../__tests__/clerk-mock";

const context = testContext();

describe("createCliRun()", () => {
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

  function baseParams(overrides?: Partial<CliRunParams>): CliRunParams {
    return {
      userId: user.userId,
      agentComposeVersionId: versionId,
      prompt: "Hello, world!",
      orgTier: "free",
      ...overrides,
    };
  }

  describe("Happy Path", () => {
    it("should create and dispatch a run successfully", async () => {
      const result: CreateRunResult = await createCliRun(baseParams());

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
      const result = await createCliRun(
        baseParams({ appendSystemPrompt: "Your name is Aria." }),
      );

      const run = await findTestRunRecord(result.runId);

      expect(run!.appendSystemPrompt).toBe("Your name is Aria.");
    });

    it("should default appendSystemPrompt to null when not provided", async () => {
      const result = await createCliRun(baseParams());

      const run = await findTestRunRecord(result.runId);

      expect(run!.appendSystemPrompt).toBeNull();
    });

    it("should propagate appendSystemPrompt through runner job dispatch", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const result = await createCliRun(
        baseParams({ appendSystemPrompt: "Your name is Aria." }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run!.appendSystemPrompt).toBe("Your name is Aria.");

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
    });

    it("should always set lastHeartbeatAt", async () => {
      const result = await createCliRun(baseParams());

      const run = await findTestRunRecord(result.runId);

      expect(run!.lastHeartbeatAt).not.toBeNull();
    });

    it("should refresh lastHeartbeatAt during pipeline", async () => {
      const result = await createCliRun(baseParams());

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
      const result = await createCliRun(baseParams({ vars }));

      const run = await findTestRunRecord(result.runId);

      expect(run!.vars).toEqual(vars);
    });

    it("should store secretNames when secrets provided", async () => {
      const secrets = { API_KEY: "sk-123", DB_PASS: "pw" };
      const result = await createCliRun(baseParams({ secrets }));

      const run = await findTestRunRecord(result.runId);

      expect(run!.secretNames).toEqual(["API_KEY", "DB_PASS"]);
    });
  });

  describe("Concurrent Run Limit", () => {
    it("should reject when free tier limit reached", async () => {
      // Free tier (default) allows only 1 concurrent run
      await createCliRun(baseParams({ prompt: "First run" }));

      // Second run should be rejected with concurrent run limit error
      await expect(
        createCliRun(baseParams({ prompt: "Second run" })),
      ).rejects.toSatisfy(isConcurrentRunLimit);
    });

    it("should allow 2 concurrent runs for pro tier", async () => {
      await updateOrgTier(user.orgId, "pro");

      const run1 = await createCliRun(
        baseParams({ prompt: "Pro run 1", orgTier: "pro" }),
      );
      const run2 = await createCliRun(
        baseParams({ prompt: "Pro run 2", orgTier: "pro" }),
      );

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
    });

    it("should reject 3rd concurrent run for pro tier", async () => {
      await updateOrgTier(user.orgId, "pro");

      await createCliRun(baseParams({ prompt: "Pro run 1", orgTier: "pro" }));
      await createCliRun(baseParams({ prompt: "Pro run 2", orgTier: "pro" }));

      await expect(
        createCliRun(baseParams({ prompt: "Pro run 3", orgTier: "pro" })),
      ).rejects.toSatisfy(isConcurrentRunLimit);
    });

    it("should allow multiple concurrent runs for team tier", async () => {
      await updateOrgTier(user.orgId, "team");

      // Create 3 concurrent runs to verify team tier allows more than pro tier (which allows 2)
      const run1 = await createCliRun(
        baseParams({ prompt: "Team run 1", orgTier: "team" }),
      );
      const run2 = await createCliRun(
        baseParams({ prompt: "Team run 2", orgTier: "team" }),
      );
      const run3 = await createCliRun(
        baseParams({ prompt: "Team run 3", orgTier: "team" }),
      );

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
      expect(run3.status).toBe("pending");
    });

    it("should allow unlimited runs when CONCURRENT_RUN_LIMIT_CAP is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      const run1 = await createCliRun(baseParams({ prompt: "Run 1" }));
      const run2 = await createCliRun(baseParams({ prompt: "Run 2" }));

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
    });

    it("should not count stale pending runs", async () => {
      // Free tier limit is 1; stale pending run should not count
      await insertStalePendingRun(user.userId, versionId);

      const result = await createCliRun(baseParams());
      expect(result.status).toBe("pending");
    });

    it("should reject second run when concurrency limit reached", async () => {
      // Free tier limit is 1 — advisory lock should serialize them
      const results = await Promise.allSettled([
        createCliRun(baseParams({ prompt: "Concurrent A" })),
        createCliRun(baseParams({ prompt: "Concurrent B" })),
      ]);

      // One should succeed, one should be rejected
      const fulfilled = results.filter((r) => {
        return r.status === "fulfilled";
      });
      const rejected = results.filter((r) => {
        return r.status === "rejected";
      });
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    it("should enforce limit per-org, not per-user", async () => {
      // Create a run in the default org (fills its free-tier slot)
      await createCliRun(baseParams({ prompt: "Org 1 run" }));

      // Create a second user with a different org
      const otherUser = await context.setupUser({ prefix: "org-user" });
      const otherCompose = await createTestCompose(uniqueId("other-agent"));

      // Run in the other org should succeed (separate org, separate limit)
      const result = await createCliRun({
        userId: otherUser.userId,
        agentComposeVersionId: otherCompose.versionId,
        prompt: "Org 2 run",
        orgTier: "free",
      });
      expect(result.status).toBe("pending");
    });
  });

  describe("Validation", () => {
    it("should reject mutually exclusive checkpointId and sessionId", async () => {
      await expect(
        createCliRun(
          baseParams({
            checkpointId: "some-checkpoint",
            sessionId: "some-session",
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

      const result = await createCliRun(baseParams({ callbacks }));

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
      const result = await createCliRun(baseParams({ memoryName }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should succeed when memory already exists (idempotent)", async () => {
      // Allow concurrent runs for this test
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      const memoryName = uniqueId("existing-mem");
      // First run creates the memory
      await createCliRun(baseParams({ memoryName }));

      // Second run should also succeed (idempotent)
      const result = await createCliRun(
        baseParams({ memoryName, prompt: "second run" }),
      );
      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should accept memoryName and dispatch successfully", async () => {
      const result = await createCliRun(
        baseParams({ memoryName: "my-memory" }),
      );

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
            cliAgentSessionHistoryHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
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
      const continueResult = await createCliRun(
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
      const result = await createCliRun(baseParams({ artifactName }));

      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should succeed when artifact already exists", async () => {
      const artifactName = uniqueId("existing-art");
      await createTestArtifact(artifactName);

      const result = await createCliRun(baseParams({ artifactName }));

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

      const result = await createCliRun(
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
      const result = await createCliRun(
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
        createCliRun(baseParams({ agentComposeVersionId: compose.versionId })),
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
      const result = await createCliRun(
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
      const result = await createCliRun(
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
      const result = await createCliRun(
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

      const result = await createCliRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should use default executor when RUNNER_DEFAULT_GROUP is not set", async () => {
      // RUNNER_DEFAULT_GROUP is not set by default in test env
      mockClerk({ userId: user.userId, email: "team@vm0.ai" });

      const result = await createCliRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should mark run as failed when runner group is not vm0/*", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "nonexistent-org/default");
      reloadEnv();

      mockClerk({ userId: user.userId, email: "user@example.com" });

      let caughtError: unknown;
      try {
        await createCliRun(baseParams());
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
      expect(run!.error).toMatch(/vm0/);
    });
  });

  describe("Experimental Profile", () => {
    it("should store profile in runner job queue when experimental_profile is set", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const compose = await createTestCompose(uniqueId("profile-agent"), {
        overrides: { experimental_profile: "vm0/default" },
      });

      const result = await createCliRun(
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

      const result = await createCliRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.profile).toBe("vm0/default");
      expect(job!.executionContext.experimentalProfile).toBe("vm0/default");
    });

    it("should filter jobs by profiles array in poll endpoint", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      // Create two runs — one with default profile, one with explicit profile
      const browserCompose = await createTestCompose(
        uniqueId("browser-agent"),
        { overrides: { experimental_profile: "vm0/default" } },
      );
      await createCliRun(baseParams({ prompt: "default job" }));
      await createCliRun(
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
        createCliRun(baseParams({ agentComposeVersionId: compose.versionId })),
      ).rejects.toSatisfy(isBadRequest);
    });
  });

  describe("Org Resolution for Storage", () => {
    it("should use compose org for artifact/memory storage", async () => {
      const result = await createCliRun(
        baseParams({
          artifactName: "artifact",
          memoryName: "memory",
        }),
      );

      expect(result.status).toBe("pending");

      // Verify the run record was created
      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();

      // Verify artifact storage was created in the compose's org (user's default org)
      const artifact = await findTestStorage(
        user.orgId,
        "artifact",
        "artifact",
      );
      expect(artifact).toBeDefined();
      expect(artifact!.userId).toBe(user.userId);

      // Verify memory storage was created in the compose's org
      const memory = await findTestStorage(user.orgId, "memory", "memory");
      expect(memory).toBeDefined();
      expect(memory!.userId).toBe(user.userId);
    });
  });

  // NOTE: Model Provider Env Var Injection and Connector Secret Injection tests
  // have been moved to zero layer tests (zero-run-service.test.ts, build-zero-context.test.ts)
  // because these are zero business logic concerns, not infra concerns.
});
