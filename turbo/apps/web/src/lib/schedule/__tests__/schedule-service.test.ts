import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import { initServices } from "../../init-services";
import { agentSchedules } from "../../../db/schema/agent-schedule";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { scopes } from "../../../db/schema/scope";
import { users } from "../../../db/schema/user";

// Mock run service to avoid actual execution
vi.mock("../../run/run-service", () => ({
  runService: {
    buildExecutionContext: vi.fn(),
    prepareAndDispatch: vi.fn(),
    checkConcurrencyLimit: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock sandbox token generation
vi.mock("../../auth/sandbox-token", () => ({
  generateSandboxToken: vi.fn().mockResolvedValue("mock-sandbox-token"),
}));

// Test constants (UUIDs required by schema)
const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";
const TEST_SCOPE_ID = "00000000-0000-0000-0000-000000000098";
const TEST_COMPOSE_ID = "00000000-0000-0000-0000-000000000097";
const TEST_VERSION_ID = "test-version-sha256-hash-for-schedule-tests";
const TEST_PREFIX = "test-schedule-";

// Import ScheduleService after mocks
let ScheduleService: typeof import("../schedule-service").ScheduleService;

describe("ScheduleService", () => {
  let scheduleService: InstanceType<typeof ScheduleService>;

  beforeAll(async () => {
    initServices();
    const scheduleModule = await import("../schedule-service");
    ScheduleService = scheduleModule.ScheduleService;

    // Create test scope first (user references scope)
    await globalThis.services.db
      .insert(scopes)
      .values({
        id: TEST_SCOPE_ID,
        slug: "test-schedule-scope",
        type: "personal",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    // Create test user
    await globalThis.services.db
      .insert(users)
      .values({
        id: TEST_USER_ID,
        scopeId: TEST_SCOPE_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    // Create test compose
    await globalThis.services.db
      .insert(agentComposes)
      .values({
        id: TEST_COMPOSE_ID,
        userId: TEST_USER_ID,
        scopeId: TEST_SCOPE_ID,
        name: "test-agent",
        headVersionId: TEST_VERSION_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    // Create test compose version (required for executeSchedule)
    await globalThis.services.db
      .insert(agentComposeVersions)
      .values({
        id: TEST_VERSION_ID,
        composeId: TEST_COMPOSE_ID,
        content: { agents: { "test-agent": { framework: "test" } } },
        createdBy: TEST_USER_ID,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    scheduleService = new ScheduleService();
    vi.clearAllMocks();

    // Clean up test schedules first (they reference runs via lastRunId)
    await globalThis.services.db
      .delete(agentSchedules)
      .where(eq(agentSchedules.composeId, TEST_COMPOSE_ID));

    // Then clean up test runs
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.agentComposeVersionId, TEST_VERSION_ID));
  });

  afterAll(async () => {
    // Clean up all test data (order matters due to foreign keys)
    // Schedules reference runs via lastRunId, so delete schedules first
    await globalThis.services.db
      .delete(agentSchedules)
      .where(eq(agentSchedules.composeId, TEST_COMPOSE_ID));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.agentComposeVersionId, TEST_VERSION_ID));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, TEST_VERSION_ID));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, TEST_COMPOSE_ID));

    await globalThis.services.db
      .delete(users)
      .where(eq(users.id, TEST_USER_ID));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, TEST_SCOPE_ID));
  });

  describe("deploy", () => {
    it("should create a new schedule with cron expression", async () => {
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}cron-job`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Run daily task",
      });

      expect(result.created).toBe(true);
      expect(result.schedule.name).toBe(`${TEST_PREFIX}cron-job`);
      expect(result.schedule.cronExpression).toBe("0 9 * * *");
      expect(result.schedule.timezone).toBe("UTC");
      expect(result.schedule.enabled).toBe(false);
      expect(result.schedule.nextRunAt).not.toBeNull();
    });

    it("should create a new schedule with at time (one-time)", async () => {
      const futureTime = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString();

      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}one-time`,
        composeId: TEST_COMPOSE_ID,
        atTime: futureTime,
        timezone: "UTC",
        prompt: "Run once",
      });

      expect(result.created).toBe(true);
      expect(result.schedule.atTime).toBe(futureTime);
      expect(result.schedule.cronExpression).toBeNull();
    });

    it("should update existing schedule when deploying with same name", async () => {
      // Create initial schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}update-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Original prompt",
      });

      // Update with same name
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}update-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 10 * * *",
        timezone: "America/New_York",
        prompt: "Updated prompt",
      });

      expect(result.created).toBe(false);
      expect(result.schedule.cronExpression).toBe("0 10 * * *");
      expect(result.schedule.timezone).toBe("America/New_York");
      expect(result.schedule.prompt).toBe("Updated prompt");
    });

    it("should reject creating second schedule for same agent (1:1 constraint)", async () => {
      // Create first schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}first`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "First schedule",
      });

      // Try to create second schedule with different name
      await expect(
        scheduleService.deploy(TEST_USER_ID, {
          name: `${TEST_PREFIX}second`,
          composeId: TEST_COMPOSE_ID,
          cronExpression: "0 10 * * *",
          timezone: "UTC",
          prompt: "Second schedule",
        }),
      ).rejects.toThrow("This agent already has a schedule");
    });

    it("should encrypt secrets when provided", async () => {
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}with-secrets`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Task with secrets",
        secrets: {
          API_KEY: "secret-value-123",
          DB_PASSWORD: "another-secret",
        },
      });

      expect(result.schedule.secretNames).toEqual(["API_KEY", "DB_PASSWORD"]);
    });

    it("should store variables", async () => {
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}with-vars`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Task with vars",
        vars: {
          ENV: "production",
          REGION: "us-west-2",
        },
      });

      expect(result.schedule.vars).toEqual({
        ENV: "production",
        REGION: "us-west-2",
      });
    });

    it("should reject deploy for non-owned compose", async () => {
      await expect(
        scheduleService.deploy("different-user", {
          name: `${TEST_PREFIX}unauthorized`,
          composeId: TEST_COMPOSE_ID,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Should fail",
        }),
      ).rejects.toThrow("not found or not owned");
    });

    it("should reject deploy with invalid timezone", async () => {
      await expect(
        scheduleService.deploy(TEST_USER_ID, {
          name: `${TEST_PREFIX}invalid-tz`,
          composeId: TEST_COMPOSE_ID,
          cronExpression: "0 9 * * *",
          timezone: "Invalid/Timezone",
          prompt: "Should fail",
        }),
      ).rejects.toThrow("Invalid timezone");
    });

    it("should accept valid IANA timezones", async () => {
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}valid-tz`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "America/New_York",
        prompt: "Valid timezone test",
      });

      expect(result.schedule.timezone).toBe("America/New_York");
    });
  });

  describe("deploy validation", () => {
    const COMPOSE_WITH_SECRETS_ID = "00000000-0000-0000-0000-000000000090";
    const VERSION_WITH_SECRETS_ID = "test-version-with-secrets-requirement";

    beforeAll(async () => {
      // Create a compose that requires secrets
      await globalThis.services.db
        .insert(agentComposes)
        .values({
          id: COMPOSE_WITH_SECRETS_ID,
          userId: TEST_USER_ID,
          scopeId: TEST_SCOPE_ID,
          name: "agent-with-secrets",
          headVersionId: VERSION_WITH_SECRETS_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      // Create compose version with secrets/vars requirements
      await globalThis.services.db
        .insert(agentComposeVersions)
        .values({
          id: VERSION_WITH_SECRETS_ID,
          composeId: COMPOSE_WITH_SECRETS_ID,
          content: {
            agents: {
              "agent-with-secrets": {
                framework: "test",
                environment: {
                  API_KEY: "${{ secrets.API_KEY }}",
                  DB_PASSWORD: "${{ secrets.DB_PASSWORD }}",
                  API_URL: "${{ vars.API_URL }}",
                },
              },
            },
          },
          createdBy: TEST_USER_ID,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
    });

    beforeEach(async () => {
      // Clean up schedules for this compose
      await globalThis.services.db
        .delete(agentSchedules)
        .where(eq(agentSchedules.composeId, COMPOSE_WITH_SECRETS_ID));
    });

    afterAll(async () => {
      // Clean up
      await globalThis.services.db
        .delete(agentSchedules)
        .where(eq(agentSchedules.composeId, COMPOSE_WITH_SECRETS_ID));

      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, VERSION_WITH_SECRETS_ID));

      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, COMPOSE_WITH_SECRETS_ID));
    });

    it("should reject deploy when required secrets are missing", async () => {
      await expect(
        scheduleService.deploy(TEST_USER_ID, {
          name: `${TEST_PREFIX}missing-secrets`,
          composeId: COMPOSE_WITH_SECRETS_ID,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Should fail",
        }),
      ).rejects.toThrow("Missing required configuration");
    });

    it("should reject deploy when only some required secrets are provided", async () => {
      await expect(
        scheduleService.deploy(TEST_USER_ID, {
          name: `${TEST_PREFIX}partial-secrets`,
          composeId: COMPOSE_WITH_SECRETS_ID,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Should fail",
          secrets: {
            API_KEY: "value1",
            // Missing DB_PASSWORD
          },
          vars: {
            API_URL: "https://example.com",
          },
        }),
      ).rejects.toThrow("Secrets: DB_PASSWORD");
    });

    it("should reject deploy when required vars are missing", async () => {
      await expect(
        scheduleService.deploy(TEST_USER_ID, {
          name: `${TEST_PREFIX}missing-vars`,
          composeId: COMPOSE_WITH_SECRETS_ID,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Should fail",
          secrets: {
            API_KEY: "value1",
            DB_PASSWORD: "value2",
          },
          // Missing vars.API_URL
        }),
      ).rejects.toThrow("Vars: API_URL");
    });

    it("should accept deploy when all required config is provided", async () => {
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}all-config`,
        composeId: COMPOSE_WITH_SECRETS_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Should succeed",
        secrets: {
          API_KEY: "value1",
          DB_PASSWORD: "value2",
        },
        vars: {
          API_URL: "https://example.com",
        },
      });

      expect(result.created).toBe(true);
      expect(result.schedule.secretNames).toContain("API_KEY");
      expect(result.schedule.secretNames).toContain("DB_PASSWORD");
      expect(result.schedule.vars).toEqual({ API_URL: "https://example.com" });
    });

    it("should include multiple missing items in error message", async () => {
      await expect(
        scheduleService.deploy(TEST_USER_ID, {
          name: `${TEST_PREFIX}missing-all`,
          composeId: COMPOSE_WITH_SECRETS_ID,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Should fail with detailed error",
        }),
      ).rejects.toThrow(/Secrets:.*API_KEY.*DB_PASSWORD|DB_PASSWORD.*API_KEY/);
    });

    it("should accept update when keeping existing secrets (secrets undefined)", async () => {
      // First create a schedule with secrets
      const createResult = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}keep-secrets`,
        composeId: COMPOSE_WITH_SECRETS_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Initial prompt",
        secrets: {
          API_KEY: "value1",
          DB_PASSWORD: "value2",
        },
        vars: {
          API_URL: "https://example.com",
        },
      });
      expect(createResult.created).toBe(true);

      // Update the schedule without providing secrets (undefined = keep existing)
      const updateResult = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}keep-secrets`,
        composeId: COMPOSE_WITH_SECRETS_ID,
        cronExpression: "0 10 * * *", // Changed time
        timezone: "UTC",
        prompt: "Updated prompt",
        // secrets: undefined - intentionally not provided
        vars: {
          API_URL: "https://example.com",
        },
      });

      expect(updateResult.created).toBe(false); // Update, not create
      expect(updateResult.schedule.secretNames).toContain("API_KEY");
      expect(updateResult.schedule.secretNames).toContain("DB_PASSWORD");
    });

    it("should replace secrets when new secrets are provided on update", async () => {
      // First create a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}replace-secrets`,
        composeId: COMPOSE_WITH_SECRETS_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Initial",
        secrets: { API_KEY: "old1", DB_PASSWORD: "old2" },
        vars: { API_URL: "https://example.com" },
      });

      // Update with new secrets
      const updateResult = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}replace-secrets`,
        composeId: COMPOSE_WITH_SECRETS_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Updated",
        secrets: { API_KEY: "new1", DB_PASSWORD: "new2" },
        vars: { API_URL: "https://example.com" },
      });

      expect(updateResult.schedule.secretNames).toContain("API_KEY");
      expect(updateResult.schedule.secretNames).toContain("DB_PASSWORD");
      // Note: We can't verify actual values since they're encrypted
    });

    it("should reject new schedule without secrets even if name exists for different compose", async () => {
      // This verifies that "keep existing" only works when updating the SAME schedule
      await expect(
        scheduleService.deploy(TEST_USER_ID, {
          name: `${TEST_PREFIX}new-schedule-no-secrets`,
          composeId: COMPOSE_WITH_SECRETS_ID,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Should fail",
          // No secrets provided for NEW schedule
        }),
      ).rejects.toThrow("Missing required configuration");
    });
  });

  describe("getByName", () => {
    it("should return schedule by name", async () => {
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}get-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Test prompt",
      });

      const schedule = await scheduleService.getByName(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}get-test`,
      );

      expect(schedule.name).toBe(`${TEST_PREFIX}get-test`);
      expect(schedule.prompt).toBe("Test prompt");
    });

    it("should throw NotFoundError for non-existent schedule", async () => {
      await expect(
        scheduleService.getByName(
          TEST_USER_ID,
          TEST_COMPOSE_ID,
          "non-existent",
        ),
      ).rejects.toThrow("not found");
    });

    it("should throw for unauthorized user", async () => {
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}auth-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Test",
      });

      await expect(
        scheduleService.getByName(
          "different-user",
          TEST_COMPOSE_ID,
          `${TEST_PREFIX}auth-test`,
        ),
      ).rejects.toThrow("not found or not owned");
    });
  });

  describe("list", () => {
    it("should return empty array when no schedules", async () => {
      const schedules = await scheduleService.list(TEST_USER_ID);
      expect(schedules).toEqual([]);
    });

    it("should return user schedules", async () => {
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}list-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "List test",
      });

      const schedules = await scheduleService.list(TEST_USER_ID);

      expect(schedules.length).toBe(1);
      expect(schedules[0]!.name).toBe(`${TEST_PREFIX}list-test`);
    });
  });

  describe("delete", () => {
    it("should delete schedule", async () => {
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}delete-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "To be deleted",
      });

      await scheduleService.delete(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}delete-test`,
      );

      await expect(
        scheduleService.getByName(
          TEST_USER_ID,
          TEST_COMPOSE_ID,
          `${TEST_PREFIX}delete-test`,
        ),
      ).rejects.toThrow("not found");
    });

    it("should throw NotFoundError for non-existent schedule", async () => {
      await expect(
        scheduleService.delete(TEST_USER_ID, TEST_COMPOSE_ID, "non-existent"),
      ).rejects.toThrow("not found");
    });
  });

  describe("enable/disable", () => {
    it("should enable a disabled schedule", async () => {
      // Create and disable
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}enable-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Enable test",
      });
      await scheduleService.disable(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}enable-test`,
      );

      // Enable
      const result = await scheduleService.enable(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}enable-test`,
      );

      expect(result.enabled).toBe(true);
      expect(result.nextRunAt).not.toBeNull();
    });

    it("should disable an enabled schedule", async () => {
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}disable-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Disable test",
      });

      const result = await scheduleService.disable(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}disable-test`,
      );

      expect(result.enabled).toBe(false);
    });

    it("should recalculate nextRunAt when enabling cron schedule", async () => {
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}recalc-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Recalculate test",
      });

      // Disable then enable
      await scheduleService.disable(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}recalc-test`,
      );
      const result = await scheduleService.enable(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}recalc-test`,
      );

      // nextRunAt should be recalculated
      expect(result.nextRunAt).not.toBeNull();
      const nextRun = new Date(result.nextRunAt!);
      expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    });

    it("should throw SchedulePastError when enabling one-time schedule with past atTime", async () => {
      // Create a one-time schedule with a future time
      const futureTime = new Date(Date.now() + 1000).toISOString();
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}past-onetime`,
        composeId: TEST_COMPOSE_ID,
        atTime: futureTime,
        timezone: "UTC",
        prompt: "Past one-time test",
      });

      // Manually set atTime to past (simulating time passing)
      await globalThis.services.db
        .update(agentSchedules)
        .set({ atTime: new Date(Date.now() - 60000) })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}past-onetime`));

      // Attempt to enable should throw SchedulePastError
      await expect(
        scheduleService.enable(
          TEST_USER_ID,
          TEST_COMPOSE_ID,
          `${TEST_PREFIX}past-onetime`,
        ),
      ).rejects.toThrow("has already passed");
    });

    it("should allow enabling one-time schedule with future atTime", async () => {
      // Create a one-time schedule with a future time
      const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}future-onetime`,
        composeId: TEST_COMPOSE_ID,
        atTime: futureTime,
        timezone: "UTC",
        prompt: "Future one-time test",
      });

      // Enable should succeed
      const result = await scheduleService.enable(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}future-onetime`,
      );

      expect(result.enabled).toBe(true);
      expect(result.nextRunAt).not.toBeNull();
    });
  });

  describe("toResponse", () => {
    it("should include secret names but not values", async () => {
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}secrets-response`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Secrets test",
        secrets: {
          SECRET_KEY: "secret-value",
          ANOTHER_SECRET: "another-value",
        },
      });

      // Should have secret names
      expect(result.schedule.secretNames).toContain("SECRET_KEY");
      expect(result.schedule.secretNames).toContain("ANOTHER_SECRET");

      // Should not expose actual values (verify by checking response structure)
      const responseJson = JSON.stringify(result.schedule);
      expect(responseJson).not.toContain("secret-value");
      expect(responseJson).not.toContain("another-value");
    });

    it("should return null secretNames when no secrets", async () => {
      const result = await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}no-secrets`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "No secrets",
      });

      expect(result.schedule.secretNames).toBeNull();
    });
  });

  describe("executeDueSchedules", () => {
    it("should return zero when no schedules are due", async () => {
      // Create a schedule with future nextRunAt
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}future-schedule`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Future schedule",
      });

      const result = await scheduleService.executeDueSchedules();

      expect(result.executed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("should execute due schedules", async () => {
      // Create a schedule and manually set nextRunAt to past
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}due-schedule`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Due schedule",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}due-schedule`));

      const result = await scheduleService.executeDueSchedules();

      expect(result.executed).toBe(1);
      expect(result.skipped).toBe(0);

      // Verify run was created
      const runs = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agentComposeVersionId, TEST_VERSION_ID));

      expect(runs.length).toBe(1);
      expect(runs[0]!.prompt).toBe("Due schedule");
      expect(runs[0]!.status).toBe("pending");
    });

    it("should skip schedule when previous run is still pending", async () => {
      // Create a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}pending-run`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Schedule with pending run",
      });

      // Create a pending run and link it to the schedule
      const [pendingRun] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: TEST_USER_ID,
          agentComposeVersionId: TEST_VERSION_ID,
          status: "pending",
          prompt: "Previous run",
          createdAt: new Date(),
        })
        .returning();

      // Update schedule to have past nextRunAt, enable it, and link to pending run
      await globalThis.services.db
        .update(agentSchedules)
        .set({
          nextRunAt: new Date(Date.now() - 60000),
          enabled: true,
          lastRunId: pendingRun!.id,
        })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}pending-run`));

      const result = await scheduleService.executeDueSchedules();

      expect(result.executed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should skip schedule when previous run is still running", async () => {
      // Create a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}running-run`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Schedule with running run",
      });

      // Create a running run and link it to the schedule
      const [runningRun] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: TEST_USER_ID,
          agentComposeVersionId: TEST_VERSION_ID,
          status: "running",
          prompt: "Running run",
          createdAt: new Date(),
        })
        .returning();

      // Update schedule to have past nextRunAt, enable it, and link to running run
      await globalThis.services.db
        .update(agentSchedules)
        .set({
          nextRunAt: new Date(Date.now() - 60000),
          enabled: true,
          lastRunId: runningRun!.id,
        })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}running-run`));

      const result = await scheduleService.executeDueSchedules();

      expect(result.executed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should execute schedule when previous run is completed", async () => {
      // Create a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}completed-run`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Schedule with completed run",
      });

      // Create a completed run and link it to the schedule
      const [completedRun] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: TEST_USER_ID,
          agentComposeVersionId: TEST_VERSION_ID,
          status: "success",
          prompt: "Completed run",
          createdAt: new Date(),
        })
        .returning();

      // Update schedule to have past nextRunAt, enable it, and link to completed run
      await globalThis.services.db
        .update(agentSchedules)
        .set({
          nextRunAt: new Date(Date.now() - 60000),
          enabled: true,
          lastRunId: completedRun!.id,
        })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}completed-run`));

      const result = await scheduleService.executeDueSchedules();

      expect(result.executed).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("should disable one-time schedule after execution", async () => {
      // Create a one-time schedule with atTime
      const futureTime = new Date(Date.now() + 1000).toISOString();
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}one-time`,
        composeId: TEST_COMPOSE_ID,
        atTime: futureTime,
        timezone: "UTC",
        prompt: "One-time schedule",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}one-time`));

      const result = await scheduleService.executeDueSchedules();

      expect(result.executed).toBe(1);

      // Verify schedule was disabled
      const [schedule] = await globalThis.services.db
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.name, `${TEST_PREFIX}one-time`));

      expect(schedule!.enabled).toBe(false);
      expect(schedule!.nextRunAt).toBeNull();
    });

    it("should update nextRunAt for recurring cron schedule", async () => {
      // Create a cron schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}recurring`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Recurring schedule",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}recurring`));

      await scheduleService.executeDueSchedules();

      // Verify nextRunAt was updated to future
      const [schedule] = await globalThis.services.db
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.name, `${TEST_PREFIX}recurring`));

      expect(schedule!.enabled).toBe(true);
      expect(schedule!.nextRunAt).not.toBeNull();
      expect(schedule!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      expect(schedule!.lastRunAt).not.toBeNull();
      expect(schedule!.lastRunId).not.toBeNull();
    });

    it("should not execute disabled schedules", async () => {
      // Create and disable a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}disabled`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Disabled schedule",
      });

      await scheduleService.disable(
        TEST_USER_ID,
        TEST_COMPOSE_ID,
        `${TEST_PREFIX}disabled`,
      );

      // Even if we manually set nextRunAt to past, it shouldn't execute
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000) })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}disabled`));

      const result = await scheduleService.executeDueSchedules();

      expect(result.executed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("should mark run as failed when buildExecutionContext throws", async () => {
      const { runService } = await import("../../run/run-service");

      // Make buildExecutionContext throw an error
      vi.mocked(runService.buildExecutionContext).mockRejectedValueOnce(
        new Error("Missing required secrets: API_KEY"),
      );

      // Create a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}failing-context`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Schedule that fails context building",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}failing-context`));

      const result = await scheduleService.executeDueSchedules();

      // Should be counted as skipped (error thrown but caught)
      expect(result.executed).toBe(0);
      expect(result.skipped).toBe(1);

      // Verify run was created and marked as failed
      const runs = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agentComposeVersionId, TEST_VERSION_ID));

      expect(runs.length).toBe(1);
      expect(runs[0]!.status).toBe("failed");
      expect(runs[0]!.error).toBe("Missing required secrets: API_KEY");
      expect(runs[0]!.completedAt).not.toBeNull();
    });

    it("should mark run as failed when prepareAndDispatch throws", async () => {
      const { runService } = await import("../../run/run-service");

      // Make prepareAndDispatch throw an error
      vi.mocked(runService.buildExecutionContext).mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof runService.buildExecutionContext>>,
      );
      vi.mocked(runService.prepareAndDispatch).mockRejectedValueOnce(
        new Error("Runner group scope mismatch"),
      );

      // Create a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}failing-dispatch`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Schedule that fails dispatch",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}failing-dispatch`));

      const result = await scheduleService.executeDueSchedules();

      expect(result.skipped).toBe(1);

      // Verify run was marked as failed
      const runs = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agentComposeVersionId, TEST_VERSION_ID));

      expect(runs.length).toBe(1);
      expect(runs[0]!.status).toBe("failed");
      expect(runs[0]!.error).toBe("Runner group scope mismatch");
    });

    it("should disable one-time schedule on failure", async () => {
      const { runService } = await import("../../run/run-service");

      // Make buildExecutionContext throw an error
      vi.mocked(runService.buildExecutionContext).mockRejectedValueOnce(
        new Error("Configuration error"),
      );

      // Create a one-time schedule
      const futureTime = new Date(Date.now() + 1000).toISOString();
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}failing-onetime`,
        composeId: TEST_COMPOSE_ID,
        atTime: futureTime,
        timezone: "UTC",
        prompt: "One-time schedule that fails",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}failing-onetime`));

      await scheduleService.executeDueSchedules();

      // Verify schedule was disabled
      const [schedule] = await globalThis.services.db
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.name, `${TEST_PREFIX}failing-onetime`));

      expect(schedule!.enabled).toBe(false);
      expect(schedule!.nextRunAt).toBeNull();
      expect(schedule!.lastRunAt).not.toBeNull();
    });

    it("should advance nextRunAt for cron schedule on failure", async () => {
      const { runService } = await import("../../run/run-service");

      // Make buildExecutionContext throw an error
      vi.mocked(runService.buildExecutionContext).mockRejectedValueOnce(
        new Error("Configuration error"),
      );

      // Create a cron schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}failing-cron`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Cron schedule that fails",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}failing-cron`));

      await scheduleService.executeDueSchedules();

      // Verify schedule still enabled with advanced nextRunAt
      const [schedule] = await globalThis.services.db
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.name, `${TEST_PREFIX}failing-cron`));

      expect(schedule!.enabled).toBe(true);
      expect(schedule!.nextRunAt).not.toBeNull();
      expect(schedule!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      expect(schedule!.lastRunAt).not.toBeNull();
      expect(schedule!.lastRunId).not.toBeNull();
    });

    it("should set lastRunId immediately to prevent duplicate runs", async () => {
      const { runService } = await import("../../run/run-service");

      // Make buildExecutionContext throw an error
      vi.mocked(runService.buildExecutionContext).mockRejectedValueOnce(
        new Error("Error during context building"),
      );

      // Create a schedule
      await scheduleService.deploy(TEST_USER_ID, {
        name: `${TEST_PREFIX}lastrunid-test`,
        composeId: TEST_COMPOSE_ID,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Test lastRunId is set immediately",
      });

      // Set nextRunAt to past and enable so it becomes due
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date(Date.now() - 60000), enabled: true })
        .where(eq(agentSchedules.name, `${TEST_PREFIX}lastrunid-test`));

      await scheduleService.executeDueSchedules();

      // Verify lastRunId was set even though execution failed
      const [schedule] = await globalThis.services.db
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.name, `${TEST_PREFIX}lastrunid-test`));

      expect(schedule!.lastRunId).not.toBeNull();

      // Verify the run exists and is linked
      const runs = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, schedule!.lastRunId!));

      expect(runs.length).toBe(1);
      expect(runs[0]!.status).toBe("failed");
    });
  });
});
