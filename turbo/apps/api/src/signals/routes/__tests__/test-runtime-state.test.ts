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
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { setRunModelProviderFixture } from "../../../test-fixtures/agent-runs";
import {
  deleteVm0BuiltInCandidateCooldownFixture,
  resolveVm0BuiltInModelRouteFixture,
  readRunChatToolActivityDecision,
  registerVm0BuiltInCandidateCooldownCleanup,
  seedVm0BuiltInModelCandidateKeys,
  seedVm0BuiltInModelKey,
  setVm0BuiltInCandidateCooldownFixture,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const reads = createRunReadsApi(context);

interface ClaimedVm0Run {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly runId: string;
  readonly selectedModel: string;
}

async function createClaimedVm0Run(): Promise<ClaimedVm0Run> {
  const keyFixture = await seedVm0BuiltInModelCandidateKeys(
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
    displayName: "BDD built-in model failure report agent",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "report a built-in model provider failure",
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
  it("captures the effective tool-activity switch once per run", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected the run actor to have an org");
    }
    const featureActor = { ...actor, orgId: actor.orgId };
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD immutable tool activity decision agent",
    });

    await updateFeatureSwitchesForUser(context, featureActor, {
      [FeatureSwitchKey.ChatToolActivity]: true,
    });
    const enabledRun = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "capture enabled tool activity",
    });
    onTestFinished(async () => {
      await runs.requestCancelRun(actor, enabledRun.runId, [200, 400]);
    });

    await updateFeatureSwitchesForUser(context, featureActor, {
      [FeatureSwitchKey.ChatToolActivity]: false,
    });
    const disabledRun = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "capture disabled tool activity",
    });
    onTestFinished(async () => {
      await runs.requestCancelRun(actor, disabledRun.runId, [200, 400]);
    });

    await expect(
      readRunChatToolActivityDecision(context, enabledRun.runId),
    ).resolves.toStrictEqual({
      run_id: enabledRun.runId,
      chat_tool_activity_enabled: true,
    });
    await expect(
      readRunChatToolActivityDecision(context, disabledRun.runId),
    ).resolves.toStrictEqual({
      run_id: disabledRun.runId,
      chat_tool_activity_enabled: false,
    });
  });

  it("keeps overlapping VM0 built-in model-key fixtures independently releasable", async () => {
    const first = await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");
    const second = await seedVm0BuiltInModelKey(context, "gpt-5.6-terra");

    expect(first.selectedModel).toBe("gpt-5.6-terra");
    expect(second.selectedModel).toBe("gpt-5.6-terra");

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
    "disables Codex apply patch for the VM0 %s OpenRouter fallback",
    async (selectedModel) => {
      await seedVm0BuiltInModelCandidateKeys(context, selectedModel);
      const startedAt = Date.UTC(2026, 7, 23, 0, 0, 0);
      const primaryCooldownUntil = new Date(startedAt + 60 * 1000);
      const primary = await withMockNowForTest(startedAt, async () => {
        return await resolveVm0BuiltInModelRouteFixture(
          context,
          selectedModel,
          true,
        );
      });
      if (!primary) {
        throw new Error(`Expected a primary route for ${selectedModel}`);
      }
      await setVm0BuiltInCandidateCooldownFixture(
        context,
        selectedModel,
        primary,
        primaryCooldownUntil,
      );
      const fallback = await withMockNowForTest(startedAt, async () => {
        return await resolveVm0BuiltInModelRouteFixture(
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
        throw new Error("Expected built-in fallback actor to have an org");
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
          [FeatureSwitchKey.BuiltInModelProviderFallback]: true,
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
      const detail = await reads.requestReadLogById(actor, runId, [200]);
      expect(detail.body).toMatchObject({
        modelProvider: "vm0",
        selectedModel,
        modelRuntimeProvider: fallback.provider_type,
        modelRuntimeModel: fallback.upstream_model,
      });
    },
  );

  it("isolates expiry-based cooldowns to exact built-in model routes", async () => {
    await seedVm0BuiltInModelCandidateKeys(context, "claude-fable-5");
    await seedVm0BuiltInModelCandidateKeys(context, "gpt-5.6-sol");
    const startedAt = Date.UTC(2026, 7, 20, 0, 0, 0);
    const routeCooldownUntil = new Date(startedAt + 60 * 1000);

    const gptPrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0BuiltInModelRouteFixture(
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

    await setVm0BuiltInCandidateCooldownFixture(
      context,
      "gpt-5.6-sol",
      gptPrimary,
      routeCooldownUntil,
    );
    const gptFallback = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0BuiltInModelRouteFixture(
        context,
        "gpt-5.6-sol",
        true,
      );
    });
    expect(gptFallback?.provider_type).toBe("openrouter-codex");
    if (!gptFallback) {
      throw new Error("Expected a fallback GPT route");
    }

    await setVm0BuiltInCandidateCooldownFixture(
      context,
      "gpt-5.6-sol",
      gptFallback,
      routeCooldownUntil,
    );

    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveVm0BuiltInModelRouteFixture(context, "gpt-5.6-sol", false),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
      await expect(
        resolveVm0BuiltInModelRouteFixture(context, "gpt-5.6-sol", true),
      ).resolves.toBeNull();
      await expect(
        resolveVm0BuiltInModelRouteFixture(context, "gpt-5.6-terra", true),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
    });

    const gptTerraPrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0BuiltInModelRouteFixture(
        context,
        "gpt-5.6-terra",
        true,
      );
    });
    if (!gptTerraPrimary) {
      throw new Error("Expected a primary GPT Terra route");
    }
    await setVm0BuiltInCandidateCooldownFixture(
      context,
      "gpt-5.6-terra",
      gptTerraPrimary,
      routeCooldownUntil,
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveVm0BuiltInModelRouteFixture(context, "gpt-5.6-terra", true),
      ).resolves.toMatchObject({ provider_type: "openrouter-codex" });
    });

    const claudePrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0BuiltInModelRouteFixture(
        context,
        "claude-fable-5",
        true,
      );
    });
    expect(claudePrimary?.provider_type).toBe("anthropic-api-key");
    if (!claudePrimary) {
      throw new Error("Expected a primary Claude route");
    }
    await setVm0BuiltInCandidateCooldownFixture(
      context,
      "claude-fable-5",
      claudePrimary,
      routeCooldownUntil,
    );
    const claudeFallback = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0BuiltInModelRouteFixture(
        context,
        "claude-fable-5",
        true,
      );
    });
    expect(claudeFallback?.provider_type).toBe("openrouter-api-key");
    if (!claudeFallback) {
      throw new Error("Expected a fallback Claude route");
    }
    await setVm0BuiltInCandidateCooldownFixture(
      context,
      "claude-fable-5",
      claudeFallback,
      routeCooldownUntil,
    );

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD built-in fallback unavailable agent",
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
      throw new Error("Expected built-in fallback actor to have an org");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.BuiltInModelProviderFallback]: true,
      },
    );
    const rejected = await withMockNowForTest(startedAt, async () => {
      return await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "reject before constructing a built-in-model run",
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
          "Every built-in model route for this model is temporarily unavailable",
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
        resolveVm0BuiltInModelRouteFixture(context, "gpt-5.6-sol", true),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
      await expect(
        resolveVm0BuiltInModelRouteFixture(context, "claude-fable-5", true),
      ).resolves.toMatchObject({ provider_type: "anthropic-api-key" });
    });
  });

  it("reads and deletes a built-in candidate cooldown", async () => {
    const selectedModel = "gpt-5.6-terra";
    const startedAt = Date.UTC(2026, 7, 20, 2, 0, 0);
    await seedVm0BuiltInModelCandidateKeys(context, selectedModel);
    const primary = await withMockNowForTest(startedAt, async () => {
      return await resolveVm0BuiltInModelRouteFixture(
        context,
        selectedModel,
        true,
      );
    });
    if (!primary) {
      throw new Error("Expected a primary GPT Terra route");
    }

    await setVm0BuiltInCandidateCooldownFixture(
      context,
      selectedModel,
      primary,
      new Date(startedAt + 60_000),
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveVm0BuiltInModelRouteFixture(context, selectedModel, true),
      ).resolves.toMatchObject({ provider_type: "openrouter-codex" });
    });

    await deleteVm0BuiltInCandidateCooldownFixture(
      context,
      selectedModel,
      primary,
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveVm0BuiltInModelRouteFixture(context, selectedModel, true),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
    });
  });
});

describe("POST /api/runners/runs/:runId/model-provider-failures", () => {
  it.each([
    {
      caseName: "authentication intervention",
      failureKind: "authentication",
      retryAfterSeconds: 1,
      cooldownSeconds: 30 * 60,
    },
    {
      caseName: "billing intervention",
      failureKind: "billing",
      retryAfterSeconds: 1,
      cooldownSeconds: 30 * 60,
    },
    {
      caseName: "rate limit default",
      failureKind: "rate_limit",
      retryAfterSeconds: undefined,
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "provider unavailable default",
      failureKind: "provider_unavailable",
      retryAfterSeconds: undefined,
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "timeout default",
      failureKind: "timeout",
      retryAfterSeconds: undefined,
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "connection default",
      failureKind: "connection",
      retryAfterSeconds: undefined,
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "bounded provider retry delay",
      failureKind: "rate_limit",
      retryAfterSeconds: 120,
      cooldownSeconds: 120,
    },
  ] as const)(
    "records the $caseName cooldown for only the persisted built-in model route",
    async ({ failureKind, retryAfterSeconds, cooldownSeconds }) => {
      const startedAt = Date.UTC(2026, 7, 21, 0, 0, 0);
      await withMockNowForTest(startedAt, async () => {
        const claimed = await createClaimedVm0Run();
        const primary = await resolveVm0BuiltInModelRouteFixture(
          context,
          claimed.selectedModel,
          true,
        );
        if (!primary) {
          throw new Error("Expected a built-in model primary route");
        }
        registerVm0BuiltInCandidateCooldownCleanup(
          context,
          claimed.selectedModel,
          primary,
        );

        await expect(
          runs.reportRunnerModelProviderFailure(claimed.runId, {
            failureKind,
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
          }),
        ).resolves.toStrictEqual({ outcome: "recorded" });
        expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
          "Built-in model provider failure report recorded",
          expect.objectContaining({
            type: "built_in_model_provider_cooldown",
            context: "Runners",
            runId: claimed.runId,
            selectedModel: claimed.selectedModel,
            providerType: primary.provider_type,
            upstreamModel: primary.upstream_model,
            failureKind,
            retryAfterSeconds: cooldownSeconds,
            unavailableUntil: new Date(
              startedAt + cooldownSeconds * 1000,
            ).toISOString(),
          }),
        );
        await expect(
          runs.readRun(claimed.actor, claimed.runId),
        ).resolves.toMatchObject({ status: "running" });
        await expect(
          resolveVm0BuiltInModelRouteFixture(
            context,
            claimed.selectedModel,
            false,
          ),
        ).resolves.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });
        await expect(
          resolveVm0BuiltInModelRouteFixture(
            context,
            claimed.selectedModel,
            true,
          ),
        ).resolves.not.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });

        await seedVm0BuiltInModelCandidateKeys(context, "deepseek-v4-pro");
        await expect(
          resolveVm0BuiltInModelRouteFixture(context, "deepseek-v4-pro", true),
        ).resolves.toMatchObject({ provider_type: "deepseek" });

        await withMockNowForTest(
          startedAt + cooldownSeconds * 1000 - 1,
          async () => {
            await expect(
              resolveVm0BuiltInModelRouteFixture(
                context,
                claimed.selectedModel,
                true,
              ),
            ).resolves.not.toMatchObject({
              provider_type: primary.provider_type,
              upstream_model: primary.upstream_model,
            });
          },
        );
        await withMockNowForTest(
          startedAt + cooldownSeconds * 1000,
          async () => {
            await expect(
              resolveVm0BuiltInModelRouteFixture(
                context,
                claimed.selectedModel,
                true,
              ),
            ).resolves.toMatchObject({
              provider_type: primary.provider_type,
              upstream_model: primary.upstream_model,
            });
          },
        );
      });
    },
  );

  it("writes a reported cooldown to the built-in table", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 30, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedVm0Run();
      const primary = await resolveVm0BuiltInModelRouteFixture(
        context,
        claimed.selectedModel,
        true,
      );
      if (!primary) {
        throw new Error("Expected a built-in model primary route");
      }
      registerVm0BuiltInCandidateCooldownCleanup(
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

      const expiredDeadline = new Date(startedAt - 1);
      await setVm0BuiltInCandidateCooldownFixture(
        context,
        claimed.selectedModel,
        primary,
        expiredDeadline,
      );
      await expect(
        resolveVm0BuiltInModelRouteFixture(
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

  it("records failure cooldowns for the canonical built-in discriminator", async () => {
    const claimed = await createClaimedVm0Run();
    await setRunModelProviderFixture({
      runId: claimed.runId,
      modelProvider: "built-in",
    });
    const primary = await resolveVm0BuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
      true,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerVm0BuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );

    await expect(
      runs.reportRunnerModelProviderFailure(claimed.runId, {
        failureKind: "rate_limit",
        retryAfterSeconds: 60,
      }),
    ).resolves.toStrictEqual({ outcome: "recorded" });
  });

  it("monotonically extends concurrent bounded reports from receipt time", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 1, 0, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedVm0Run();
      const primary = await resolveVm0BuiltInModelRouteFixture(
        context,
        claimed.selectedModel,
        true,
      );
      if (!primary) {
        throw new Error("Expected a built-in model primary route");
      }
      registerVm0BuiltInCandidateCooldownCleanup(
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
          resolveVm0BuiltInModelRouteFixture(
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
          resolveVm0BuiltInModelRouteFixture(
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
      const primary = await resolveVm0BuiltInModelRouteFixture(
        context,
        claimed.selectedModel,
        true,
      );
      if (!primary) {
        throw new Error("Expected a built-in model primary route");
      }
      registerVm0BuiltInCandidateCooldownCleanup(
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
        resolveVm0BuiltInModelRouteFixture(
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
