import { randomUUID } from "node:crypto";

import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { ALL_RUN_STATUSES } from "@okouai/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  resolveVm0ManagedModelRouteFixture,
  registerVm0ManagedCandidateCooldownCleanup,
  seedVm0ManagedModelCandidateKeys,
  seedVm0ManagedModelKey,
  setVm0ManagedCandidateCooldownFixture,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

interface ClaimedVm0Run {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly runId: string;
  readonly selectedModel: string;
}

async function createClaimedVm0Run(): Promise<ClaimedVm0Run> {
  const keyFixture = await seedVm0ManagedModelCandidateKeys(
    context,
    DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  );
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD managed model failure report agent",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "report a managed model provider failure",
    modelProvider: "vm0",
  });
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 7,
  };
  await runs.heartbeatRunner(runnerGroup);
  await runs.claimRunnerJob(run.runId, { runnerIdentity });
  onTestFinished(async () => {
    await runs.requestCancelRun(actor, run.runId, [200, 400]);
  });
  return {
    actor,
    agentId: agent.agentId,
    runId: run.runId,
    selectedModel: keyFixture.selectedModel,
  };
}

describe("POST /api/test/runtime-state/action", () => {
  it("keeps overlapping VM0 managed model-key fixtures independently releasable", async () => {
    const first = await seedVm0ManagedModelKey(context, "gpt-5.6-terra");
    const second = await seedVm0ManagedModelKey(context, "gpt-5.6-terra");

    expect(first.selectedModel).toBe("gpt-5.6-terra");
    expect(second.selectedModel).toBe("gpt-5.6-terra");

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
    "disables Codex apply patch for the VM0 %s OpenRouter fallback",
    async (selectedModel) => {
      await seedVm0ManagedModelCandidateKeys(context, selectedModel);
      const startedAt = Date.UTC(2026, 7, 23, 0, 0, 0);
      const primaryCooldownUntil = new Date(startedAt + 60 * 1000);
      const primary = await withMockNowForTest(startedAt, async () => {
        return await resolveVm0ManagedModelRouteFixture(
          context,
          selectedModel,
          true,
        );
      });
      if (!primary) {
        throw new Error(`Expected a primary route for ${selectedModel}`);
      }
      await setVm0ManagedCandidateCooldownFixture(
        context,
        selectedModel,
        primary,
        primaryCooldownUntil,
      );
      const fallback = await withMockNowForTest(startedAt, async () => {
        return await resolveVm0ManagedModelRouteFixture(
          context,
          selectedModel,
          true,
        );
      });
      if (!fallback || fallback.provider_type !== "openrouter-codex") {
        throw new Error(`Expected an OpenRouter fallback for ${selectedModel}`);
      }

      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected managed fallback actor to have an org");
      }
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: `BDD ${selectedModel} fallback catalog agent`,
      });
      await runs.updateOrgModelPolicies(actor, [
        {
          model: selectedModel,
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId },
        {
          [FeatureSwitchKey.ManagedModelProviderFallback]: true,
        },
      );

      const sent = await withMockNowForTest(startedAt, async () => {
        return await chat.requestSendEvent(
          actor,
          {
            agentId: agent.agentId,
            prompt: `use the ${selectedModel} OpenRouter fallback`,
            model: selectedModel,
          },
          [201],
        );
      });
      if (sent.status !== 201 || sent.body.runId === null) {
        throw new Error(`Expected a ${selectedModel} run`);
      }
      const runId = sent.body.runId;
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(runId);
      onTestFinished(async () => {
        await runs.requestCancelRun(actor, runId, [200, 400]);
      });

      expect(claim.environment?.OPENAI_MODEL).toBe(fallback.upstream_model);
      expect(claim.codexRuntimeConfig?.providerId).toBe("openrouter-codex");
      expect(claim.codexRuntimeConfig?.modelCatalog?.models).toStrictEqual([
        expect.objectContaining({
          slug: fallback.upstream_model,
          apply_patch_tool_type: null,
        }),
      ]);
    },
  );

  it("isolates expiry-based cooldowns to exact managed routes", async () => {
    await seedVm0ManagedModelCandidateKeys(context, "claude-fable-5");
    await seedVm0ManagedModelCandidateKeys(context, "gpt-5.6-sol");
    const startedAt = Date.UTC(2026, 7, 20, 0, 0, 0);
    const routeCooldownUntil = new Date(startedAt + 60 * 1000);

    const gptPrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0ManagedModelRouteFixture(
        context,
        "gpt-5.6-sol",
        true,
      );
    });
    expect(gptPrimary).toMatchObject({
      provider_type: "openai-api-key",
      upstream_model: "gpt-5.6-sol",
    });
    if (!gptPrimary) {
      throw new Error("Expected a primary GPT route");
    }

    await setVm0ManagedCandidateCooldownFixture(
      context,
      "gpt-5.6-sol",
      gptPrimary,
      routeCooldownUntil,
    );
    const gptFallback = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0ManagedModelRouteFixture(
        context,
        "gpt-5.6-sol",
        true,
      );
    });
    expect(gptFallback?.provider_type).toBe("openrouter-codex");
    if (!gptFallback) {
      throw new Error("Expected a fallback GPT route");
    }

    await setVm0ManagedCandidateCooldownFixture(
      context,
      "gpt-5.6-sol",
      gptFallback,
      routeCooldownUntil,
    );

    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "gpt-5.6-sol", false),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "gpt-5.6-sol", true),
      ).resolves.toBeNull();
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "gpt-5.6-terra", true),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
    });

    const gptTerraPrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0ManagedModelRouteFixture(
        context,
        "gpt-5.6-terra",
        true,
      );
    });
    if (!gptTerraPrimary) {
      throw new Error("Expected a primary GPT Terra route");
    }
    await setVm0ManagedCandidateCooldownFixture(
      context,
      "gpt-5.6-terra",
      gptTerraPrimary,
      routeCooldownUntil,
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "gpt-5.6-terra", true),
      ).resolves.toMatchObject({ provider_type: "openrouter-codex" });
    });

    const claudePrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0ManagedModelRouteFixture(
        context,
        "claude-fable-5",
        true,
      );
    });
    expect(claudePrimary?.provider_type).toBe("anthropic-api-key");
    if (!claudePrimary) {
      throw new Error("Expected a primary Claude route");
    }
    await setVm0ManagedCandidateCooldownFixture(
      context,
      "claude-fable-5",
      claudePrimary,
      routeCooldownUntil,
    );
    const claudeFallback = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0ManagedModelRouteFixture(
        context,
        "claude-fable-5",
        true,
      );
    });
    expect(claudeFallback?.provider_type).toBe("openrouter-api-key");
    if (!claudeFallback) {
      throw new Error("Expected a fallback Claude route");
    }
    await setVm0ManagedCandidateCooldownFixture(
      context,
      "claude-fable-5",
      claudeFallback,
      routeCooldownUntil,
    );

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD managed fallback unavailable agent",
    });
    await runs.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    if (!actor.orgId) {
      throw new Error("Expected managed fallback actor to have an org");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ManagedModelProviderFallback]: true,
      },
    );
    const rejected = await withMockNowForTest(startedAt, async () => {
      return await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "reject before constructing a managed-model run",
          model: "gpt-5.6-sol",
          clientEventId: randomUUID(),
        },
        [503],
      );
    });
    expect(rejected.body).toStrictEqual({
      error: {
        code: "MODEL_PROVIDER_UNAVAILABLE",
        message:
          "Every managed route for this model is temporarily unavailable",
      },
    });
    await expect(
      runs.listAgentRuns(actor, {
        status: ALL_RUN_STATUSES.join(","),
        limit: 20,
      }),
    ).resolves.toStrictEqual({ runs: [] });

    await withMockNowForTest(routeCooldownUntil.getTime(), async () => {
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "gpt-5.6-sol", true),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "claude-fable-5", true),
      ).resolves.toMatchObject({ provider_type: "anthropic-api-key" });
    });
  });
});

describe("POST /api/runners/runs/:runId/model-provider-failures", () => {
  it("records a bounded cooldown for only the persisted managed route", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 0, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedVm0Run();
      const primary = await resolveVm0ManagedModelRouteFixture(
        context,
        claimed.selectedModel,
        true,
      );
      if (!primary) {
        throw new Error("Expected a managed model primary route");
      }
      registerVm0ManagedCandidateCooldownCleanup(
        context,
        claimed.selectedModel,
        primary,
      );

      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "authentication",
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });
      await expect(
        runs.readRun(claimed.actor, claimed.runId),
      ).resolves.toMatchObject({ status: "running" });
      await expect(
        resolveVm0ManagedModelRouteFixture(
          context,
          claimed.selectedModel,
          false,
        ),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
      await expect(
        resolveVm0ManagedModelRouteFixture(
          context,
          claimed.selectedModel,
          true,
        ),
      ).resolves.not.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });

      await seedVm0ManagedModelCandidateKeys(context, "deepseek-v4-pro");
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "deepseek-v4-pro", true),
      ).resolves.toMatchObject({ provider_type: "deepseek" });

      await withMockNowForTest(startedAt + 60_000, async () => {
        await expect(
          resolveVm0ManagedModelRouteFixture(
            context,
            claimed.selectedModel,
            true,
          ),
        ).resolves.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });
      });
    });
  });

  it("monotonically extends concurrent bounded reports from receipt time", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 1, 0, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedVm0Run();
      const primary = await resolveVm0ManagedModelRouteFixture(
        context,
        claimed.selectedModel,
        true,
      );
      if (!primary) {
        throw new Error("Expected a managed model primary route");
      }
      registerVm0ManagedCandidateCooldownCleanup(
        context,
        claimed.selectedModel,
        primary,
      );

      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "rate_limit",
          retryAfterSeconds: 300,
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });

      await withMockNowForTest(startedAt + 100_000, async () => {
        await expect(
          Promise.all([
            runs.reportRunnerModelProviderFailure(claimed.runId, {
              failureKind: "timeout",
              retryAfterSeconds: 1,
            }),
            runs.reportRunnerModelProviderFailure(claimed.runId, {
              failureKind: "provider_unavailable",
              retryAfterSeconds: 300,
            }),
          ]),
        ).resolves.toStrictEqual([
          { outcome: "recorded" },
          { outcome: "recorded" },
        ]);
      });

      await withMockNowForTest(startedAt + 350_000, async () => {
        await expect(
          resolveVm0ManagedModelRouteFixture(
            context,
            claimed.selectedModel,
            true,
          ),
        ).resolves.not.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });
      });
      await withMockNowForTest(startedAt + 401_000, async () => {
        await expect(
          resolveVm0ManagedModelRouteFixture(
            context,
            claimed.selectedModel,
            true,
          ),
        ).resolves.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });
      });
    });
  });

  it("rejects untrusted or invalid reports and ignores ineligible runs", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 2, 0, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedVm0Run();
      const primary = await resolveVm0ManagedModelRouteFixture(
        context,
        claimed.selectedModel,
        true,
      );
      if (!primary) {
        throw new Error("Expected a managed model primary route");
      }
      registerVm0ManagedCandidateCooldownCleanup(
        context,
        claimed.selectedModel,
        primary,
      );

      const missingAuth = await runs.requestRunnerModelProviderFailureAs(
        undefined,
        claimed.runId,
        [401],
        {
          failureKind: "connection",
        },
      );
      expectApiError(missingAuth.body);

      const sandboxAuth = await runs.requestRunnerModelProviderFailureAs(
        `Bearer ${runs.sandboxTokenForRun(claimed.actor, claimed.runId)}`,
        claimed.runId,
        [401],
        {
          failureKind: "connection",
        },
      );
      expectApiError(sandboxAuth.body);

      const pat = await runs.createCliToken(claimed.actor);
      const patAuth = await runs.requestRunnerModelProviderFailureAs(
        `Bearer ${pat.token}`,
        claimed.runId,
        [403],
        {
          failureKind: "connection",
        },
      );
      expectApiError(patAuth.body);

      for (const body of [
        {
          failureKind: "connection",
          selectedModel: claimed.selectedModel,
        },
        {
          failureKind: "success",
        },
        {
          failureKind: "connection",
          retryAfterSeconds: 301,
        },
      ]) {
        const invalid = await runs.requestRawRunnerModelProviderFailure(
          true,
          claimed.runId,
          [400],
          body,
        );
        expectApiError(invalid.body);
      }

      for (const failureKind of [
        "unclassified",
        "semantic",
        "request",
        "schema",
        "tool_capability",
        "user_code",
        "cancellation",
      ]) {
        const invalid = await runs.requestRawRunnerModelProviderFailure(
          true,
          claimed.runId,
          [400],
          {
            failureKind,
          },
        );
        expectApiError(invalid.body);
      }

      const byokRun = await runs.createRun(claimed.actor, {
        agentId: claimed.agentId,
        prompt: "ignore a BYOK model provider failure",
        modelProvider: "anthropic-api-key",
      });
      const byokRunnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 8,
      };
      await runs.claimRunnerJob(byokRun.runId, {
        runnerIdentity: byokRunnerIdentity,
      });
      onTestFinished(async () => {
        await runs.requestCancelRun(claimed.actor, byokRun.runId, [200, 400]);
      });
      await expect(
        runs.reportRunnerModelProviderFailure(byokRun.runId, {
          failureKind: "billing",
        }),
      ).resolves.toStrictEqual({ outcome: "ignored" });

      await expect(
        resolveVm0ManagedModelRouteFixture(
          context,
          claimed.selectedModel,
          true,
        ),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
  });
});
