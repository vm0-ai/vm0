import { describe, it, expect, beforeEach } from "vitest";
import { POST as deployScheduleRoute } from "../../app/api/zero/schedules/route";
import { adaptScheduleTrigger } from "../lib/zero/schedule/adapt-schedule-trigger";
import {
  createTestRequest,
  createTestCompose,
  createTestOrgModelProvider,
  createTestOrg,
  setTestZeroAgentModelProvider,
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

  // Create the org default model provider if needed
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
    it("stores schedule with explicit model override values", async () => {
      const userId = uniqueId("sched-api-ovrd");
      const { orgId } = await setupOrgWithProviders(
        userId,
        "anthropic-api-key",
        "claude-sonnet-4-6",
      );

      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const agentName = uniqueId("agent");
      const { agentId } = await createTestCompose(agentName);

      // Create model provider for the agent's model
      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const provider = await createTestOrgModelProvider(
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.6",
      );

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
            modelProviderId: provider.id,
            selectedModel: "kimi-k2.6",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.schedule.modelProviderId).toBe(provider.id);
      expect(data.schedule.selectedModel).toBe("kimi-k2.6");
    });

    it("returns 400 when modelProviderId references a provider not in the org", async () => {
      const userId = uniqueId("sched-api-400");
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

      expect(response.status).toBe(400);
    });

    it("stores schedule with null model when agent has custom model but schedule uses agent default", async () => {
      const userId = uniqueId("sched-api-agent");
      const { orgId } = await setupOrgWithProviders(
        userId,
        "anthropic-api-key",
        "claude-sonnet-4-6",
      );

      // Create a moonshot provider that will be the agent's custom model
      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const agentProvider = await createTestOrgModelProvider(
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.6",
      );

      // Create agent with a specific model (different from org default)
      mockClerk({ userId, orgId, orgRole: "org:admin" });
      const { agentId } = await createTestCompose(uniqueId("agent"));
      await setTestZeroAgentModelProvider(
        agentId,
        agentProvider.id,
        "kimi-k2.6",
      );

      // Create schedule with "agent default" (null model fields)
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
            prompt: "Schedule using agent default model",
            cronExpression: "0 0 * * *",
            modelProviderId: null,
            selectedModel: null,
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();

      // The schedule stores null for both model fields when agent default is selected
      expect(data.schedule.modelProviderId).toBeNull();
      expect(data.schedule.selectedModel).toBeNull();
    });
  });

  describe("adaptScheduleTrigger model passthrough", () => {
    it("converts null modelProviderId to undefined so runtime fallback kicks in", () => {
      const result = adaptScheduleTrigger({
        userId: "test-user",
        agentId: "test-agent",
        scheduleId: "test-schedule",
        prompt: "test",
        appendSystemPrompt: undefined,
        triggerType: "cron",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
        modelProviderId: null,
        selectedModel: null,
        apiStartTime: Date.now(),
      });

      // null → undefined so resolveEffectiveModel's ?? chain falls through to agent model
      expect(result.modelProviderId).toBeUndefined();
      expect(result.selectedModelOverride).toBeUndefined();
    });

    it("passes through explicit model values", () => {
      const result = adaptScheduleTrigger({
        userId: "test-user",
        agentId: "test-agent",
        scheduleId: "test-schedule",
        prompt: "test",
        appendSystemPrompt: undefined,
        triggerType: "cron",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
        modelProviderId: "provider-123",
        selectedModel: "claude-opus-4-7",
        apiStartTime: Date.now(),
      });

      expect(result.modelProviderId).toBe("provider-123");
      expect(result.selectedModelOverride).toBe("claude-opus-4-7");
    });

    it("converts undefined modelProviderId to undefined", () => {
      const result = adaptScheduleTrigger({
        userId: "test-user",
        agentId: "test-agent",
        scheduleId: "test-schedule",
        prompt: "test",
        appendSystemPrompt: undefined,
        triggerType: "loop",
        cronExpression: undefined,
        timezone: "UTC",
        apiStartTime: Date.now(),
        // modelProviderId and selectedModel omitted entirely
      });

      expect(result.modelProviderId).toBeUndefined();
      expect(result.selectedModelOverride).toBeUndefined();
    });
  });
});
