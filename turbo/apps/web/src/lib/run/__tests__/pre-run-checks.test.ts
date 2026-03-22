import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  findTestRunsByUserAndPrompt,
  insertOrgDefaultModelProvider,
} from "../../../__tests__/api-test-helpers";
import { createRun } from "../run-service";
import {
  isNoModelProvider,
  insufficientCredits,
  noModelProvider,
  isApiError,
} from "../../errors";

const context = testContext();

describe("pre-run checks", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("no model provider check", () => {
    it("should reject when no model provider configured", async () => {
      // Compose with no API key env vars → requires org default provider
      const compose = await createTestCompose(uniqueId("agent"), {
        skipDefaultApiKey: true,
      });

      await expect(
        createRun({
          userId: user.userId,
          agentComposeVersionId: compose.versionId,
          prompt: "No provider test",
          orgId: user.orgId,
        }),
      ).rejects.toSatisfy(isNoModelProvider);
    });

    it("should not create a run record when rejected", async () => {
      const compose = await createTestCompose(uniqueId("agent"), {
        skipDefaultApiKey: true,
      });
      const prompt = "No provider - verify no record";

      await expect(
        createRun({
          userId: user.userId,
          agentComposeVersionId: compose.versionId,
          prompt,
          orgId: user.orgId,
        }),
      ).rejects.toSatisfy(isNoModelProvider);

      const runs = await findTestRunsByUserAndPrompt(user.userId, prompt);
      expect(runs).toHaveLength(0);
    });

    it("should allow when org has a default model provider", async () => {
      const compose = await createTestCompose(uniqueId("agent"), {
        skipDefaultApiKey: true,
      });
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

      const result = await createRun({
        userId: user.userId,
        agentComposeVersionId: compose.versionId,
        prompt: "Has default provider",
        orgId: user.orgId,
      });

      expect(result.status).toBe("pending");
    });

    it("should allow when explicit modelProvider param is provided", async () => {
      const compose = await createTestCompose(uniqueId("agent"), {
        skipDefaultApiKey: true,
      });

      const result = await createRun({
        userId: user.userId,
        agentComposeVersionId: compose.versionId,
        prompt: "Explicit provider",
        orgId: user.orgId,
        modelProvider: "anthropic-api-key",
      });

      expect(result.status).toBe("pending");
    });

    it("should allow when compose has explicit provider env vars", async () => {
      // Default compose includes ANTHROPIC_API_KEY
      const compose = await createTestCompose(uniqueId("agent"));

      const result = await createRun({
        userId: user.userId,
        agentComposeVersionId: compose.versionId,
        prompt: "Has API key in env",
        orgId: user.orgId,
      });

      expect(result.status).toBe("pending");
    });
  });

  describe("isApiError generic type guard", () => {
    it("should identify NoModelProviderError as API error", () => {
      const error = noModelProvider();
      expect(isApiError(error)).toBe(true);
      expect(error.statusCode).toBe(422);
      expect(error.code).toBe("NO_MODEL_PROVIDER");
    });

    it("should identify InsufficientCreditsError as API error", () => {
      const error = insufficientCredits(0);
      expect(isApiError(error)).toBe(true);
      expect(error.statusCode).toBe(402);
      expect(error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("should not identify plain Error as API error", () => {
      const error = new Error("plain error");
      expect(isApiError(error)).toBe(false);
    });
  });
});
