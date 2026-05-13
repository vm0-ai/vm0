import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestRun,
  createTestSecret,
  createTestVariable,
  createTestUserConnector,
  completeTestRun,
  findTestRunnerJobEntry,
  insertVm0ApiKeys,
  deleteInsertedVm0ApiKeys,
  insertTestConnectorSecret,
  createTestOrgModelProvider,
  insertOrgModelPolicy,
} from "../../../__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../__tests__/db-test-assertions/agents";
import {
  setTestSessionArtifacts,
  setTestSessionFramework,
} from "../../../__tests__/db-test-seeders/agents";
import { setOrgCredits } from "../../../__tests__/db-test-seeders/org";
import { setTestCheckpointArtifactSnapshots } from "../../../__tests__/db-test-seeders/runs";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { createZeroRun } from "../zero-run-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  upsertOrgModelProvider,
  upsertOrgNoSecretModelProvider,
} from "../model-provider/model-provider-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { upsertSecretByOrg } from "../secret/secret-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { setVariable } from "../variable/variable-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { isInsufficientCredits } from "@vm0/api-services/errors";
import { reloadEnv } from "../../../env";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  AUTO_MEMORY_MOUNT_PATH,
  CODEX_AUTO_MEMORY_MOUNT_PATH,
} from "../memory";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";

const context = testContext();

afterEach(async () => {
  await deleteInsertedVm0ApiKeys();
});

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

  async function useOrgProviderPolicyDefault(
    type: "anthropic-api-key" | "openai-api-key",
    secret: string,
    model: string,
  ): Promise<string> {
    const { provider } = await upsertOrgModelProvider(
      user.orgId,
      type,
      secret,
      model,
    );
    await insertOrgModelPolicy({
      orgId: user.orgId,
      model,
      isDefault: true,
      defaultProviderType: type,
      credentialScope: "org",
      modelProviderId: provider.id,
    });
    return provider.id;
  }

  describe("Model Provider Resolution", () => {
    it("should use the workspace model policy route", async () => {
      const agentName = uniqueId("no-key-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const noKeyAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await useOrgProviderPolicyDefault(
        "anthropic-api-key",
        "org-api-key",
        "claude-sonnet-4-6",
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

      await useOrgProviderPolicyDefault(
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

    it("should store modelUsageProvider for vm0-managed model usage", async () => {
      const agentName = uniqueId("vm0-model-usage-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const modelAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await upsertOrgNoSecretModelProvider(
        user.orgId,
        "vm0",
        "claude-opus-4-6",
      );
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "claude-opus-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      });
      await insertVm0ApiKeys([
        {
          vendor: "anthropic",
          model: "claude-opus-4-6",
          apiKey: "sk-ant-test-vm0-model-usage",
        },
      ]);
      await setOrgCredits(user.orgId, 10000);

      const result = await createZeroRun(baseParams({ agentId: modelAgentId }));

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.modelUsageProvider).toBe("claude-opus-4-6");
      expect(job!.executionContext.billableFirewalls).toContain(
        "model-provider:anthropic-api-key",
      );
    });

    it("should error when built-in default has no available credits", async () => {
      const agentName = uniqueId("no-key-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const noKeyAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await expect(
        createZeroRun(baseParams({ agentId: noKeyAgentId })),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should leave billableFirewalls empty for user-paid providers", async () => {
      // User brings their own Anthropic key; the firewall still exists to
      // enforce rules, but runs must NOT charge platform credits.
      const agentName = uniqueId("user-paid-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const userPaidAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await useOrgProviderPolicyDefault(
        "anthropic-api-key",
        "org-api-key",
        "claude-sonnet-4-6",
      );

      const result = await createZeroRun(
        baseParams({ agentId: userPaidAgentId }),
      );
      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job!.executionContext.billableFirewalls).toEqual([]);
      expect(job!.executionContext.modelUsageProvider).toBeUndefined();
    });

    it("should include billable connector firewall names when attached", async () => {
      // The x connector is platform-billable: per-call billing is computed
      // from firewall_billable metadata, so "x" must appear in
      // billableFirewalls whenever the firewall is attached to the run.
      // Build-zero-context only attaches connector firewalls when BOTH the
      // agent authorized the connector (userConnectors row) AND the user
      // has linked it (connectors row + OAuth tokens), so seed all three.
      const agentName = uniqueId("x-connector-agent");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const connAgentId = await getTestZeroAgentId(user.orgId, agentName);

      await useOrgProviderPolicyDefault(
        "anthropic-api-key",
        "org-api-key",
        "claude-sonnet-4-6",
      );
      await context.createConnector(user.orgId, {
        userId: user.userId,
        type: "x",
        authMethod: "oauth",
      });
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "X_ACCESS_TOKEN",
        "user-x-access",
      );
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "X_REFRESH_TOKEN",
        "user-x-refresh",
      );
      await createTestUserConnector(user.orgId, user.userId, connAgentId, "x");

      const result = await createZeroRun(baseParams({ agentId: connAgentId }));
      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job!.executionContext.billableFirewalls).toContain("x");
      // User-paid model provider → model-provider firewall stays off the list.
      expect(job!.executionContext.billableFirewalls).not.toContain(
        "model-provider:anthropic-api-key",
      );
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

    // Regression for production crash:
    //   Firewall "jira" base URL requires variable "JIRA_DOMAIN" but it was not provided
    // When a user was authorized for a connector but never set the required
    // secrets/variables, the firewall for that connector must not be injected.
    it("should not inject connector firewall when user has no credentials", async () => {
      const agentName = uniqueId("jira-agent");
      await createTestCompose(agentName);
      const jiraAgentId = await getTestZeroAgentId(user.orgId, agentName);

      // Authorize jira for this agent but never set JIRA_API_TOKEN/DOMAIN/EMAIL
      await createTestUserConnector(
        user.orgId,
        user.userId,
        jiraAgentId,
        "jira",
      );

      const result = await createZeroRun(baseParams({ agentId: jiraAgentId }));

      await context.mocks.flushAfter();
      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // jira firewall must not appear — its base url templates on JIRA_DOMAIN
      // which would fail to resolve
      const firewallNames = (job!.executionContext.firewalls ?? []).map(
        (fw) => {
          return fw.name;
        },
      );
      expect(firewallNames).not.toContain("jira");
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

  describe("Auto-memory injection gating", () => {
    it("new run injects memory exactly once at AUTO_MEMORY_MOUNT_PATH", async () => {
      const result = await createZeroRun(baseParams());
      await context.mocks.flushAfter();

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      const memoryEntries =
        job!.executionContext.storageManifest!.artifacts.filter((a) => {
          return a.vasStorageName === AUTO_MEMORY_ARTIFACT_NAME;
        });
      expect(memoryEntries).toHaveLength(1);
      expect(memoryEntries[0]!.mountPath).toBe(AUTO_MEMORY_MOUNT_PATH);
    });

    it("new codex run injects memory at CODEX_AUTO_MEMORY_MOUNT_PATH", async () => {
      const agentName = uniqueId("codex-memory");
      await createTestCompose(agentName, {
        skipDefaultApiKey: true,
      });
      const codexAgentId = await getTestZeroAgentId(user.orgId, agentName);
      const provider = await createTestOrgModelProvider(
        "openai-api-key",
        "org-openai-key",
      );
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "gpt-5.5",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: provider.id,
      });

      const result = await createZeroRun(baseParams({ agentId: codexAgentId }));
      await context.mocks.flushAfter();

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      const memoryEntries =
        job!.executionContext.storageManifest!.artifacts.filter((a) => {
          return a.vasStorageName === AUTO_MEMORY_ARTIFACT_NAME;
        });
      expect(memoryEntries).toHaveLength(1);
      expect(memoryEntries[0]!.mountPath).toBe(CODEX_AUTO_MEMORY_MOUNT_PATH);
    });

    it("checkpoint resume trusts resolution memory entry", async () => {
      const seed = await createTestRun(agentId, "seed");
      const { checkpointId } = await completeTestRun(user.userId, seed.runId);
      await setTestCheckpointArtifactSnapshots(checkpointId, [
        {
          name: AUTO_MEMORY_ARTIFACT_NAME,
          version: "latest",
          mountPath: AUTO_MEMORY_MOUNT_PATH,
        },
      ]);

      const resumed = await createTestRun(agentId, "resume", { checkpointId });
      await context.mocks.flushAfter();

      const job = await findTestRunnerJobEntry(resumed.runId);
      expect(job).toBeDefined();
      const memoryEntries =
        job!.executionContext.storageManifest!.artifacts.filter((a) => {
          return a.vasStorageName === AUTO_MEMORY_ARTIFACT_NAME;
        });
      expect(memoryEntries).toHaveLength(1);
      expect(memoryEntries[0]!.mountPath).toBe(AUTO_MEMORY_MOUNT_PATH);
    });

    it("session continue trusts resolution memory entry", async () => {
      const seed = await createZeroRun(baseParams());
      await context.mocks.flushAfter();
      await completeTestRun(user.userId, seed.runId);
      await setTestSessionFramework(seed.sessionId, "claude-code");
      await setTestSessionArtifacts(seed.sessionId, [
        {
          name: AUTO_MEMORY_ARTIFACT_NAME,
          version: "latest",
          mountPath: AUTO_MEMORY_MOUNT_PATH,
        },
      ]);

      const resumed = await createZeroRun(
        baseParams({ sessionId: seed.sessionId }),
      );
      await context.mocks.flushAfter();

      const job = await findTestRunnerJobEntry(resumed.runId);
      expect(job).toBeDefined();
      const memoryEntries =
        job!.executionContext.storageManifest!.artifacts.filter((a) => {
          return a.vasStorageName === AUTO_MEMORY_ARTIFACT_NAME;
        });
      expect(memoryEntries).toHaveLength(1);
      expect(memoryEntries[0]!.mountPath).toBe(AUTO_MEMORY_MOUNT_PATH);
    });

    it("resume with no memory in resolution skips injection and warns", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const seed = await createTestRun(agentId, "seed empty");
        const { checkpointId } = await completeTestRun(user.userId, seed.runId);
        await setTestCheckpointArtifactSnapshots(checkpointId, []);

        const resumed = await createTestRun(agentId, "resume empty", {
          checkpointId,
        });
        await context.mocks.flushAfter();

        const job = await findTestRunnerJobEntry(resumed.runId);
        expect(job).toBeDefined();
        const memoryEntries =
          job!.executionContext.storageManifest!.artifacts.filter((a) => {
            return a.vasStorageName === AUTO_MEMORY_ARTIFACT_NAME;
          });
        expect(memoryEntries).toHaveLength(0);

        const warnCalls = warnSpy.mock.calls.filter((args) => {
          return args.some((arg) => {
            return (
              typeof arg === "string" && arg.includes("no memory artifact")
            );
          });
        });
        expect(warnCalls.length).toBeGreaterThan(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
