import { describe, it, expect } from "vitest";
import {
  scheduleYamlSchema,
  scheduleTriggerSchema,
  scheduleRunConfigSchema,
  scheduleDefinitionSchema,
  deployScheduleRequestSchema,
  scheduleResponseSchema,
  runSummarySchema,
  scheduleRunsResponseSchema,
} from "../schedules";

describe("schedules contracts", () => {
  describe("scheduleTriggerSchema", () => {
    it("should accept valid cron trigger", () => {
      const result = scheduleTriggerSchema.safeParse({
        cron: "0 9 * * *",
        timezone: "America/New_York",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cron).toBe("0 9 * * *");
        expect(result.data.timezone).toBe("America/New_York");
      }
    });

    it("should accept valid at trigger", () => {
      const result = scheduleTriggerSchema.safeParse({
        at: "2025-12-31T23:59:59Z",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.at).toBe("2025-12-31T23:59:59Z");
        expect(result.data.timezone).toBe("UTC"); // default
      }
    });

    it("should reject when both cron and at are provided", () => {
      const result = scheduleTriggerSchema.safeParse({
        cron: "0 9 * * *",
        at: "2025-12-31T23:59:59Z",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Exactly one of 'cron' or 'at' must be specified",
        );
      }
    });

    it("should reject when neither cron nor at is provided", () => {
      const result = scheduleTriggerSchema.safeParse({
        timezone: "UTC",
      });

      expect(result.success).toBe(false);
    });

    it("should default timezone to UTC", () => {
      const result = scheduleTriggerSchema.safeParse({
        cron: "0 * * * *",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timezone).toBe("UTC");
      }
    });
  });

  describe("scheduleRunConfigSchema", () => {
    it("should accept valid run config", () => {
      const result = scheduleRunConfigSchema.safeParse({
        agent: "my-agent",
        prompt: "Run the daily report",
        vars: { ENV: "production" },
        secrets: { API_KEY: "sk-123" },
      });

      expect(result.success).toBe(true);
    });

    it("should require agent", () => {
      const result = scheduleRunConfigSchema.safeParse({
        prompt: "Run something",
      });

      expect(result.success).toBe(false);
    });

    it("should require prompt", () => {
      const result = scheduleRunConfigSchema.safeParse({
        agent: "my-agent",
      });

      expect(result.success).toBe(false);
    });

    it("should reject empty agent", () => {
      const result = scheduleRunConfigSchema.safeParse({
        agent: "",
        prompt: "Run something",
      });

      expect(result.success).toBe(false);
    });

    it("should reject empty prompt", () => {
      const result = scheduleRunConfigSchema.safeParse({
        agent: "my-agent",
        prompt: "",
      });

      expect(result.success).toBe(false);
    });

    it("should accept optional artifact config", () => {
      const result = scheduleRunConfigSchema.safeParse({
        agent: "my-agent",
        prompt: "Run with artifact",
        artifactName: "my-artifact",
        artifactVersion: "1.0.0",
        volumeVersions: { data: "v2" },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("scheduleDefinitionSchema", () => {
    it("should accept valid schedule definition", () => {
      const result = scheduleDefinitionSchema.safeParse({
        on: {
          cron: "0 9 * * 1-5",
          timezone: "America/Los_Angeles",
        },
        run: {
          agent: "daily-reporter",
          prompt: "Generate the daily report",
        },
      });

      expect(result.success).toBe(true);
    });

    it("should reject invalid trigger", () => {
      const result = scheduleDefinitionSchema.safeParse({
        on: {
          // Missing both cron and at
          timezone: "UTC",
        },
        run: {
          agent: "my-agent",
          prompt: "Run",
        },
      });

      expect(result.success).toBe(false);
    });
  });

  describe("scheduleYamlSchema", () => {
    it("should accept valid schedule.yaml structure", () => {
      const result = scheduleYamlSchema.safeParse({
        version: "1.0",
        schedules: {
          "daily-report": {
            on: {
              cron: "0 9 * * *",
              timezone: "UTC",
            },
            run: {
              agent: "reporter",
              prompt: "Generate daily report",
            },
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should accept multiple schedules", () => {
      const result = scheduleYamlSchema.safeParse({
        version: "1.0",
        schedules: {
          "morning-task": {
            on: { cron: "0 9 * * *" },
            run: { agent: "worker", prompt: "Morning task" },
          },
          "evening-task": {
            on: { cron: "0 18 * * *" },
            run: { agent: "worker", prompt: "Evening task" },
          },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data.schedules)).toHaveLength(2);
      }
    });

    it("should require version 1.0", () => {
      const result = scheduleYamlSchema.safeParse({
        version: "2.0",
        schedules: {},
      });

      expect(result.success).toBe(false);
    });

    it("should accept empty schedules object", () => {
      const result = scheduleYamlSchema.safeParse({
        version: "1.0",
        schedules: {},
      });

      expect(result.success).toBe(true);
    });
  });

  describe("deployScheduleRequestSchema", () => {
    it("should accept valid deploy request with cron", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "daily-task",
        composeId: "123e4567-e89b-12d3-a456-426614174000",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Run the task",
      });

      expect(result.success).toBe(true);
    });

    it("should accept valid deploy request with atTime", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "one-time-task",
        composeId: "123e4567-e89b-12d3-a456-426614174000",
        atTime: "2025-12-31T23:59:59Z",
        timezone: "UTC",
        prompt: "Run once",
      });

      expect(result.success).toBe(true);
    });

    it("should reject name longer than 64 chars", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "a".repeat(65),
        composeId: "123e4567-e89b-12d3-a456-426614174000",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Run",
      });

      expect(result.success).toBe(false);
    });

    it("should reject invalid composeId (not UUID)", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "task",
        composeId: "not-a-uuid",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Run",
      });

      expect(result.success).toBe(false);
    });

    it("should require prompt", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "task",
        composeId: "123e4567-e89b-12d3-a456-426614174000",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      });

      expect(result.success).toBe(false);
    });

    it("should accept optional vars and secrets", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "task",
        composeId: "123e4567-e89b-12d3-a456-426614174000",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Run with vars",
        vars: { ENV: "prod" },
        secrets: { API_KEY: "secret" },
      });

      expect(result.success).toBe(true);
    });

    it("should reject when both cronExpression and atTime are provided", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "task",
        composeId: "123e4567-e89b-12d3-a456-426614174000",
        cronExpression: "0 9 * * *",
        atTime: "2025-12-31T23:59:59Z",
        timezone: "UTC",
        prompt: "Run",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Exactly one of 'cronExpression' or 'atTime' must be specified",
        );
      }
    });

    it("should reject when neither cronExpression nor atTime is provided", () => {
      const result = deployScheduleRequestSchema.safeParse({
        name: "task",
        composeId: "123e4567-e89b-12d3-a456-426614174000",
        timezone: "UTC",
        prompt: "Run",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Exactly one of 'cronExpression' or 'atTime' must be specified",
        );
      }
    });
  });

  describe("scheduleResponseSchema", () => {
    it("should accept valid schedule response", () => {
      const result = scheduleResponseSchema.safeParse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        composeId: "123e4567-e89b-12d3-a456-426614174001",
        composeName: "my-agent",
        scopeSlug: "user-abc123",
        name: "daily-task",
        cronExpression: "0 9 * * *",
        atTime: null,
        timezone: "UTC",
        prompt: "Run the task",
        vars: { ENV: "prod" },
        secretNames: ["API_KEY", "DB_PASSWORD"],
        artifactName: null,
        artifactVersion: null,
        volumeVersions: null,
        enabled: true,
        nextRunAt: "2025-01-13T09:00:00Z",
        lastRunAt: "2025-01-12T09:00:00Z",
        retryStartedAt: null,
        createdAt: "2025-01-12T10:00:00Z",
        updatedAt: "2025-01-12T10:00:00Z",
      });

      expect(result.success).toBe(true);
    });

    it("should accept response with nullable fields as null", () => {
      const result = scheduleResponseSchema.safeParse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        composeId: "123e4567-e89b-12d3-a456-426614174001",
        composeName: "my-agent",
        scopeSlug: "user-abc123",
        name: "task",
        cronExpression: null,
        atTime: "2025-12-31T23:59:59Z",
        timezone: "UTC",
        prompt: "One-time run",
        vars: null,
        secretNames: null,
        artifactName: null,
        artifactVersion: null,
        volumeVersions: null,
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        retryStartedAt: null,
        createdAt: "2025-01-12T10:00:00Z",
        updatedAt: "2025-01-12T10:00:00Z",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("runSummarySchema", () => {
    it("should accept valid run summary", () => {
      const result = runSummarySchema.safeParse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        status: "completed",
        createdAt: "2025-01-12T10:00:00Z",
        completedAt: "2025-01-12T10:05:00Z",
        error: null,
      });

      expect(result.success).toBe(true);
    });

    it("should accept run summary with error", () => {
      const result = runSummarySchema.safeParse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        status: "failed",
        createdAt: "2025-01-12T10:00:00Z",
        completedAt: "2025-01-12T10:01:00Z",
        error: "Connection timeout",
      });

      expect(result.success).toBe(true);
    });

    it("should accept all valid status values", () => {
      const statuses = ["pending", "running", "completed", "failed", "timeout"];
      for (const status of statuses) {
        const result = runSummarySchema.safeParse({
          id: "123e4567-e89b-12d3-a456-426614174000",
          status,
          createdAt: "2025-01-12T10:00:00Z",
          completedAt: null,
          error: null,
        });
        expect(result.success).toBe(true);
      }
    });

    it("should reject invalid status", () => {
      const result = runSummarySchema.safeParse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        status: "invalid",
        createdAt: "2025-01-12T10:00:00Z",
        completedAt: null,
        error: null,
      });

      expect(result.success).toBe(false);
    });
  });

  describe("scheduleRunsResponseSchema", () => {
    it("should accept valid runs response", () => {
      const result = scheduleRunsResponseSchema.safeParse({
        runs: [
          {
            id: "123e4567-e89b-12d3-a456-426614174000",
            status: "completed",
            createdAt: "2025-01-12T10:00:00Z",
            completedAt: "2025-01-12T10:05:00Z",
            error: null,
          },
          {
            id: "123e4567-e89b-12d3-a456-426614174001",
            status: "failed",
            createdAt: "2025-01-11T10:00:00Z",
            completedAt: "2025-01-11T10:01:00Z",
            error: "Error message",
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it("should accept empty runs array", () => {
      const result = scheduleRunsResponseSchema.safeParse({
        runs: [],
      });

      expect(result.success).toBe(true);
    });
  });
});
