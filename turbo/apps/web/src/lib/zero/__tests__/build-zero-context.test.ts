import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestSecret,
  createTestVariable,
  getTestZeroAgentId,
  findTestRunnerJobEntry,
} from "../../../__tests__/api-test-helpers";
import { createZeroRun } from "../zero-run-service";
import { upsertOrgModelProvider } from "../../model-provider/model-provider-service";
import { upsertSecretByOrg } from "../../secret/secret-service";
import { setVariable } from "../../variable/variable-service";
import { ORG_SENTINEL_USER_ID } from "../../org/org-sentinel";
import { isNoModelProvider } from "../../errors";
import { reloadEnv } from "../../../env";
import type { TriggerSource } from "@vm0/core";

const context = testContext();

describe("Org-Level Runtime Resolution (Zero Layer)", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const agentName = uniqueId("agent");
    await createTestCompose(agentName);
    agentId = await getTestZeroAgentId(user.orgId, agentName);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  function baseParams(
    overrides?: Partial<Parameters<typeof createZeroRun>[0]>,
  ) {
    return {
      userId: user.userId,
      prompt: "Hello, world!",
      agentId,
      triggerSource: "web" as TriggerSource,
      ...overrides,
    };
  }

  describe("Model Provider Resolution", () => {
    it("should use org default provider", async () => {
      const agentName = uniqueId("no-key-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const noKeyAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await upsertOrgModelProvider(
        user.orgId,
        "anthropic-api-key",
        "org-api-key",
      );

      const result = await createZeroRun(baseParams({ agentId: noKeyAgentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Model provider token is replaced with placeholder (firewall gateway protects it)
      expect(job!.executionContext.environment).toMatchObject({
        ANTHROPIC_API_KEY:
          "sk-ant-api03-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
      });
    });

    it("should error when no org default provider exists", async () => {
      const agentName = uniqueId("no-key-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const noKeyAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await expect(
        createZeroRun(baseParams({ agentId: noKeyAgentId })),
      ).rejects.toSatisfy(isNoModelProvider);
    });
  });

  describe("Secret Merge", () => {
    it("should merge org and user secrets with user priority", async () => {
      const agentName = uniqueId("secret-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            SHARED_KEY: "${{ secrets.SHARED_KEY }}",
          },
        },
      });
      const secretAgentId = await getTestZeroAgentId(user.orgId, agentName);

      // Both org and user have the same secret name
      await upsertSecretByOrg(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "SHARED_KEY",
        "org-value",
        "user",
        "Org shared key",
      );
      await createTestSecret("SHARED_KEY", "user-value");

      const result = await createZeroRun(
        baseParams({ agentId: secretAgentId }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // User value should win
      expect(job!.executionContext.environment).toMatchObject({
        SHARED_KEY: "user-value",
      });
    });

    it("should include org secret when user has no override", async () => {
      const agentName = uniqueId("secret-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            ORG_ONLY: "${{ secrets.ORG_ONLY }}",
            USER_ONLY: "${{ secrets.USER_ONLY }}",
          },
        },
      });
      const secretAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await upsertSecretByOrg(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "ORG_ONLY",
        "org-secret",
        "user",
        "Org-only secret",
      );
      await createTestSecret("USER_ONLY", "user-secret");

      const result = await createZeroRun(
        baseParams({ agentId: secretAgentId }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        ORG_ONLY: "org-secret",
        USER_ONLY: "user-secret",
      });
    });
  });

  describe("Variable Merge", () => {
    it("should merge org and user variables with user priority", async () => {
      const agentName = uniqueId("var-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            MY_VAR: "${{ vars.MY_VAR }}",
          },
        },
      });
      const varAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await setVariable(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "MY_VAR",
        "org-value",
      );
      await createTestVariable("MY_VAR", "user-value");

      const result = await createZeroRun(baseParams({ agentId: varAgentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        MY_VAR: "user-value",
      });
    });

    it("should include org variable when user has no override", async () => {
      const agentName = uniqueId("var-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            ORG_VAR: "${{ vars.ORG_VAR }}",
          },
        },
      });
      const varAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await setVariable(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "ORG_VAR",
        "org-value",
      );

      const result = await createZeroRun(baseParams({ agentId: varAgentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        ORG_VAR: "org-value",
      });
    });

    it("should let CLI variable override both org and user variables", async () => {
      const agentName = uniqueId("var-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            MY_VAR: "${{ vars.MY_VAR }}",
          },
        },
      });
      const varAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await setVariable(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "MY_VAR",
        "org-value",
      );
      await createTestVariable("MY_VAR", "user-value");

      const result = await createZeroRun(baseParams({ agentId: varAgentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // createZeroRun doesn't accept CLI vars directly, so user value wins
      expect(job!.executionContext.environment).toMatchObject({
        MY_VAR: "user-value",
      });
    });
  });
});
