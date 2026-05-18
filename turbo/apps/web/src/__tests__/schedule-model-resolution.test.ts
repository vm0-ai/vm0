import { describe, it, expect, beforeEach } from "vitest";
import { POST as deployScheduleRoute } from "../../app/api/zero/schedules/route";
import { adaptScheduleTrigger } from "../lib/zero/schedule/adapt-schedule-trigger";
import {
  createTestRequest,
  createTestCompose,
  createTestOrgModelProvider,
  createTestOrg,
} from "./api-test-helpers";
import { mockClerk } from "./clerk-mock";
import { testContext, uniqueId } from "./test-helpers";

const context = testContext();

async function setupOrgWithProviders(
  userId: string,
  orgDefaultType: string,
  orgDefaultModel?: string,
) {
  const slug = uniqueId("schedmod");
  mockClerk({ userId, orgRole: "org:admin" });
  const { id: orgId } = await createTestOrg(slug);

  // Create the org-scoped provider row if needed.
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrgModelProvider(
    orgDefaultType,
    `test-secret-${slug}`,
    orgDefaultModel,
  );

  return { orgId, slug };
}

describe("Schedule model resolution", () => {
  beforeEach(async () => {
    context.setupMocks();
  });

  describe("POST /api/zero/schedules (deploy)", () => {
    it("ignores stale explicit model override values", async () => {
      const userId = uniqueId("sched-api-ovrd");
      const { orgId } = await setupOrgWithProviders(
        userId,
        "anthropic-api-key",
        "claude-sonnet-4-6",
      );

      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const agentName = uniqueId("agent");
      const { agentId } = await createTestCompose(agentName);

      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const scheduleName = uniqueId("sched");
      const response = await deployScheduleRoute(
        createTestRequest("http://localhost:3000/api/zero/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: scheduleName,
            agentId,
            timezone: "UTC",
            prompt: "Test schedule with explicit model override",
            cronExpression: "0 0 * * *",
            modelProviderId: "00000000-0000-4000-a000-000000000999",
            selectedModel: "kimi-k2.6",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.schedule.modelProviderId).toBeNull();
      expect(data.schedule.selectedModel).toBeNull();
      expect(data.schedule.preferPersonalProvider).toBe(false);
    });

    it("does not validate stale schedule model fields", async () => {
      const userId = uniqueId("sched-api-stale");
      const { orgId } = await setupOrgWithProviders(
        userId,
        "anthropic-api-key",
        "claude-sonnet-4-6",
      );

      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const agentName = uniqueId("agent");
      const { agentId } = await createTestCompose(agentName);

      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const response = await deployScheduleRoute(
        createTestRequest("http://localhost:3000/api/zero/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: uniqueId("sched"),
            agentId,
            timezone: "UTC",
            prompt: "Test with bad provider",
            cronExpression: "0 0 * * *",
            modelProviderId: "00000000-0000-0000-0000-000000000000",
            selectedModel: "nonexistent-model",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.schedule.modelProviderId).toBeNull();
      expect(data.schedule.selectedModel).toBeNull();
    });

    it("stores schedule with null model when the schedule inherits the default", async () => {
      const userId = uniqueId("sched-api-agent");
      const { orgId } = await setupOrgWithProviders(
        userId,
        "anthropic-api-key",
        "claude-sonnet-4-6",
      );

      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const { agentId } = await createTestCompose(uniqueId("agent"));

      // Create schedule with inherited default (null model fields)
      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const scheduleName = uniqueId("sched");
      const response = await deployScheduleRoute(
        createTestRequest("http://localhost:3000/api/zero/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: scheduleName,
            agentId,
            timezone: "UTC",
            prompt: "Schedule using inherited model",
            cronExpression: "0 0 * * *",
            modelProviderId: null,
            selectedModel: null,
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();

      // The schedule stores null for both model fields when inherited default is selected.
      expect(data.schedule.modelProviderId).toBeNull();
      expect(data.schedule.selectedModel).toBeNull();
    });
  });

  describe("adaptScheduleTrigger model passthrough", () => {
    it("does not include schedule model overrides so runtime fallback kicks in", () => {
      const result = adaptScheduleTrigger({
        userId: "test-user",
        agentId: "test-agent",
        scheduleId: "test-schedule",
        prompt: "test",
        appendSystemPrompt: undefined,
        triggerType: "cron",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
        apiStartTime: Date.now(),
      });

      expect(result.modelProviderId).toBeUndefined();
      expect(result.selectedModelOverride).toBeUndefined();
    });
  });
});
