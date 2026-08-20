import { randomUUID } from "node:crypto";

import { ALL_RUN_STATUSES } from "@okouai/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  resolveVm0ManagedModelRouteFixture,
  seedVm0ManagedModelCandidateKeys,
  seedVm0ManagedModelKey,
  setVm0ManagedCandidateCooldownFixture,
  setVm0ManagedCredentialCooldownFixture,
  upsertVm0ManagedModelKeyFixture,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

describe("POST /api/test/runtime-state/action", () => {
  it("keeps overlapping VM0 managed model-key fixtures independently releasable", async () => {
    const first = await seedVm0ManagedModelKey(context, "gpt-5.6-terra");
    const second = await seedVm0ManagedModelKey(context, "gpt-5.6-terra");

    expect(first.selectedModel).toBe("gpt-5.6-terra");
    expect(second.selectedModel).toBe("gpt-5.6-terra");

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });

  it("rotates managed keys without replacing identity", async () => {
    const vendor = `test-${randomUUID()}`;
    const first = await upsertVm0ManagedModelKeyFixture(context, {
      vendor,
      apiKey: "first-secret",
      label: "first-label",
    });
    const relabeled = await upsertVm0ManagedModelKeyFixture(context, {
      vendor,
      apiKey: "first-secret",
      label: "second-label",
    });
    const rotated = await upsertVm0ManagedModelKeyFixture(context, {
      vendor,
      apiKey: "second-secret",
      label: "second-label",
    });

    expect(relabeled).toStrictEqual({ ...first, revision: first.revision });
    expect(rotated).toStrictEqual({ ...first, revision: first.revision + 1 });
  });

  it("selects routes from scoped expiry-based managed cooldowns", async () => {
    await seedVm0ManagedModelCandidateKeys(context, "claude-fable-5");
    await seedVm0ManagedModelCandidateKeys(context, "gpt-5.6-sol");
    const startedAt = Date.UTC(2026, 7, 20, 0, 0, 0);
    const routeCooldownUntil = new Date(startedAt + 60 * 1000);
    const credentialCooldownUntil = new Date(startedAt + 30 * 60 * 1000);

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
      model_key_revision: expect.any(Number),
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

    await setVm0ManagedCredentialCooldownFixture(
      context,
      gptFallback,
      credentialCooldownUntil,
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
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "claude-fable-5", true),
      ).resolves.toBeNull();
    });

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
