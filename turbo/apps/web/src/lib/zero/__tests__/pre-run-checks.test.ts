import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  getTestZeroAgentId,
  findTestRunsByUserAndPrompt,
  insertOrgDefaultModelProvider,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import { createZeroRun } from "../zero-run-service";
import { isNoModelProvider } from "../../errors";
import type { TriggerSource } from "@vm0/core";

const context = testContext();

describe("zero pre-run checks", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  describe("no model provider check", () => {
    it("should reject when no model provider configured", async () => {
      // Compose with no API key env vars → requires org default provider
      const agentName = uniqueId("agent");
      await createTestCompose(agentName, { skipDefaultApiKey: true });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);

      await expect(
        createZeroRun({
          userId: user.userId,
          prompt: "No provider test",
          agentId,
          triggerSource: "web" as TriggerSource,
        }),
      ).rejects.toSatisfy(isNoModelProvider);
    });

    it("should not create a run record when rejected", async () => {
      const agentName = uniqueId("agent");
      await createTestCompose(agentName, { skipDefaultApiKey: true });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      const prompt = "No provider - verify no record";

      await expect(
        createZeroRun({
          userId: user.userId,
          prompt,
          agentId,
          triggerSource: "web" as TriggerSource,
        }),
      ).rejects.toSatisfy(isNoModelProvider);

      const runs = await findTestRunsByUserAndPrompt(user.userId, prompt);
      expect(runs).toHaveLength(0);
    });

    it("should allow when org has a default model provider", async () => {
      const agentName = uniqueId("agent");
      await createTestCompose(agentName, { skipDefaultApiKey: true });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

      const result = await createZeroRun({
        userId: user.userId,
        prompt: "Has default provider",
        agentId,
        triggerSource: "web" as TriggerSource,
      });

      expect(result.status).toBe("pending");
    });

    it("should allow when explicit modelProvider param is provided", async () => {
      const agentName = uniqueId("agent");
      await createTestCompose(agentName, { skipDefaultApiKey: true });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);

      const result = await createZeroRun({
        userId: user.userId,
        prompt: "Explicit provider",
        agentId,
        triggerSource: "web" as TriggerSource,
        modelProvider: "anthropic-api-key",
      });

      expect(result.status).toBe("pending");
    });

    it("should allow when compose has explicit provider env vars", async () => {
      // Default compose includes ANTHROPIC_API_KEY
      const agentName = uniqueId("agent");
      await createTestCompose(agentName);
      const agentId = await getTestZeroAgentId(user.orgId, agentName);

      const result = await createZeroRun({
        userId: user.userId,
        prompt: "Has API key in env",
        agentId,
        triggerSource: "web" as TriggerSource,
      });

      expect(result.status).toBe("pending");
    });
  });
});
