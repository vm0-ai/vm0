import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestSecret,
  createTestVariable,
  findTestRunnerJobEntry,
} from "../../../__tests__/api-test-helpers";
import { createRun, type CreateRunParams } from "../run-service";
import { upsertOrgModelProvider } from "../../model-provider/model-provider-service";
import { upsertSecretByOrg } from "../../secret/secret-service";
import { setVariable } from "../../variable/variable-service";
import { ORG_SENTINEL_USER_ID } from "../../org/org-sentinel";
import { isNoModelProvider } from "../../errors";

const context = testContext();

describe("Org-Level Runtime Resolution", () => {
  let user: UserContext;
  let versionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    versionId = compose.versionId;
  });

  function baseParams(overrides?: Partial<CreateRunParams>): CreateRunParams {
    return {
      userId: user.userId,
      agentComposeVersionId: versionId,
      prompt: "Hello, world!",
      orgId: user.orgId,
      ...overrides,
    };
  }

  describe("Model Provider Resolution", () => {
    it("should use org default provider", async () => {
      const noKeyCompose = await createTestCompose(uniqueId("no-key-agent"), {
        skipDefaultApiKey: true,
      });

      await upsertOrgModelProvider(
        user.orgId,
        "anthropic-api-key",
        "org-api-key",
      );

      const result = await createRun(
        baseParams({ agentComposeVersionId: noKeyCompose.versionId }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Model provider token is replaced with placeholder (firewall gateway protects it)
      expect(job!.executionContext.environment).toMatchObject({
        ANTHROPIC_API_KEY:
          "sk-ant-api03-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
      });
    });

    it("should error when no org default provider exists", async () => {
      const noKeyCompose = await createTestCompose(uniqueId("no-key-agent"), {
        skipDefaultApiKey: true,
      });

      await expect(
        createRun(
          baseParams({ agentComposeVersionId: noKeyCompose.versionId }),
        ),
      ).rejects.toSatisfy(isNoModelProvider);
    });
  });

  describe("Secret Merge", () => {
    it("should merge org and user secrets with user priority", async () => {
      const compose = await createTestCompose(uniqueId("secret-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            SHARED_KEY: "${{ secrets.SHARED_KEY }}",
          },
        },
      });

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

      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // User value should win
      expect(job!.executionContext.environment).toMatchObject({
        SHARED_KEY: "user-value",
      });
    });

    it("should include org secret when user has no override", async () => {
      const compose = await createTestCompose(uniqueId("secret-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            ORG_ONLY: "${{ secrets.ORG_ONLY }}",
            USER_ONLY: "${{ secrets.USER_ONLY }}",
          },
        },
      });

      await upsertSecretByOrg(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "ORG_ONLY",
        "org-secret",
        "user",
        "Org-only secret",
      );
      await createTestSecret("USER_ONLY", "user-secret");

      const result = await createRun(
        baseParams({ agentComposeVersionId: compose.versionId }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        ORG_ONLY: "org-secret",
        USER_ONLY: "user-secret",
      });
    });

    it("should let CLI secret override both org and user secrets", async () => {
      const compose = await createTestCompose(uniqueId("secret-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            MY_SECRET: "${{ secrets.MY_SECRET }}",
          },
        },
      });

      await upsertSecretByOrg(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "MY_SECRET",
        "org-value",
        "user",
        "Org secret",
      );
      await createTestSecret("MY_SECRET", "user-value");

      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          secrets: { MY_SECRET: "cli-value" },
        }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        MY_SECRET: "cli-value",
      });
    });
  });

  describe("Variable Merge", () => {
    it("should merge org and user variables with user priority", async () => {
      const compose = await createTestCompose(uniqueId("var-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            MY_VAR: "${{ vars.MY_VAR }}",
          },
        },
      });

      await setVariable(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "MY_VAR",
        "org-value",
      );
      await createTestVariable("MY_VAR", "user-value");

      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          checkEnv: true,
        }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        MY_VAR: "user-value",
      });
    });

    it("should include org variable when user has no override", async () => {
      const compose = await createTestCompose(uniqueId("var-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            ORG_VAR: "${{ vars.ORG_VAR }}",
          },
        },
      });

      await setVariable(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "ORG_VAR",
        "org-value",
      );

      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          checkEnv: true,
        }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        ORG_VAR: "org-value",
      });
    });

    it("should let CLI variable override both org and user variables", async () => {
      const compose = await createTestCompose(uniqueId("var-agent"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
            MY_VAR: "${{ vars.MY_VAR }}",
          },
        },
      });

      await setVariable(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "MY_VAR",
        "org-value",
      );
      await createTestVariable("MY_VAR", "user-value");

      const result = await createRun(
        baseParams({
          agentComposeVersionId: compose.versionId,
          vars: { MY_VAR: "cli-value" },
          checkEnv: true,
        }),
      );

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.environment).toMatchObject({
        MY_VAR: "cli-value",
      });
    });
  });
});
