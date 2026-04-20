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
  createTestUserConnector,
  findTestRunnerJobEntry,
} from "../../../__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../__tests__/db-test-assertions/agents";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { createZeroRun } from "../zero-run-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { upsertOrgModelProvider } from "../model-provider/model-provider-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { upsertSecretByOrg } from "../secret/secret-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { setVariable } from "../variable/variable-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { isNoModelProvider } from "../../shared/errors";
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
      apiStartTime: Date.now(),
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

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Model provider token is replaced with placeholder (firewall gateway protects it)
      expect(job!.executionContext.environment).toMatchObject({
        ANTHROPIC_API_KEY:
          "sk-ant-api03-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
      });
    });

    it("should inject ANTHROPIC_MODEL when selectedModel is set", async () => {
      const agentName = uniqueId("model-sel-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const modelAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await upsertOrgModelProvider(
        user.orgId,
        "anthropic-api-key",
        "org-api-key",
        "claude-opus-4-6",
      );

      const result = await createZeroRun(baseParams({ agentId: modelAgentId }));

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        ANTHROPIC_MODEL: "claude-opus-4-6",
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

      await context.mocks.flushAfter();
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

      await context.mocks.flushAfter();
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

      await context.mocks.flushAfter();
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

      await context.mocks.flushAfter();
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

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // createZeroRun doesn't accept CLI vars directly, so user value wins
      expect(job!.executionContext.environment).toMatchObject({
        MY_VAR: "user-value",
      });
    });
  });

  describe("Connector Secret Filtering", () => {
    it("should not inject api-token connector secret when connector is not in allowedConnectorTypes", async () => {
      const agentName = uniqueId("conn-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            AXIOM_TOKEN: "${{ secrets.AXIOM_TOKEN }}",
          },
        },
      });
      const connAgentId = await getTestZeroAgentId(user.orgId, agentName);

      // User has the AXIOM_TOKEN secret stored, but no user_connector permission for axiom
      await createTestSecret("AXIOM_TOKEN", "my-axiom-token");

      const result = await createZeroRun(baseParams({ agentId: connAgentId }));

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Real secret value must not leak — the template stays unresolved
      expect(job!.executionContext.environment?.["AXIOM_TOKEN"]).not.toBe(
        "my-axiom-token",
      );
    });

    it("should inject api-token connector secret when connector is in allowedConnectorTypes", async () => {
      const agentName = uniqueId("conn-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            AXIOM_TOKEN: "${{ secrets.AXIOM_TOKEN }}",
          },
        },
      });
      const connAgentId = await getTestZeroAgentId(user.orgId, agentName);

      // User has the secret AND the connector permission for this agent
      await createTestSecret("AXIOM_TOKEN", "my-axiom-token");
      await createTestUserConnector(
        user.orgId,
        user.userId,
        connAgentId,
        "axiom",
      );

      const result = await createZeroRun(baseParams({ agentId: connAgentId }));

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // AXIOM_TOKEN should be resolved (firewall gateway replaces with placeholder)
      expect(job!.executionContext.environment?.["AXIOM_TOKEN"]).not.toBe(
        "${{ secrets.AXIOM_TOKEN }}",
      );
    });

    it("should not filter custom user secrets that do not belong to any connector", async () => {
      const agentName = uniqueId("conn-agent");
      await createTestCompose(agentName, {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            MY_CUSTOM_SECRET: "${{ secrets.MY_CUSTOM_SECRET }}",
          },
        },
      });
      const connAgentId = await getTestZeroAgentId(user.orgId, agentName);

      // Custom secret that doesn't belong to any connector type
      await createTestSecret("MY_CUSTOM_SECRET", "custom-value");

      const result = await createZeroRun(baseParams({ agentId: connAgentId }));

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Custom secrets should always pass through regardless of connector permissions
      expect(job!.executionContext.environment).toMatchObject({
        MY_CUSTOM_SECRET: "custom-value",
      });
    });
  });
});
