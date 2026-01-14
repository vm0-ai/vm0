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
import { agentComposes } from "../../../db/schema/agent-compose";
import { scopes } from "../../../db/schema/scope";
import { users } from "../../../db/schema/user";

// Mock run service to avoid actual execution
vi.mock("../../run/run-service", () => ({
  runService: {
    buildExecutionContext: vi.fn(),
    prepareAndDispatch: vi.fn(),
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
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    scheduleService = new ScheduleService();
    vi.clearAllMocks();

    // Clean up test schedules
    await globalThis.services.db
      .delete(agentSchedules)
      .where(eq(agentSchedules.composeId, TEST_COMPOSE_ID));
  });

  afterAll(async () => {
    // Clean up all test data (order matters due to foreign keys)
    await globalThis.services.db
      .delete(agentSchedules)
      .where(eq(agentSchedules.composeId, TEST_COMPOSE_ID));

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
      expect(result.schedule.enabled).toBe(true);
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
});
