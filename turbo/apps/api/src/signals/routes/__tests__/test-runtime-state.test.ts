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
  applyVm0ManagedModelOutcomeFixture,
  clearVm0ManagedModelHealthFixture,
  resolveVm0ManagedModelRouteFixture,
  seedVm0ManagedModelCandidateKeys,
  seedVm0ManagedModelKey,
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

  it("selects, isolates, leases, and resolves managed fallback health", async () => {
    await seedVm0ManagedModelCandidateKeys(context, "claude-fable-5");
    await seedVm0ManagedModelCandidateKeys(context, "gpt-5.6-sol");
    await seedVm0ManagedModelCandidateKeys(context, "deepseek-v4-flash");
    await clearVm0ManagedModelHealthFixture(context);
    const startedAt = Date.UTC(2026, 7, 20, 0, 0, 0);
    let isolatedFallback: Awaited<
      ReturnType<typeof resolveVm0ManagedModelRouteFixture>
    > = null;

    await withMockNowForTest(startedAt, async () => {
      const disabled = await resolveVm0ManagedModelRouteFixture(
        context,
        "gpt-5.6-sol",
        false,
      );
      expect(disabled).toMatchObject({
        provider_type: "openai-api-key",
        upstream_model: "gpt-5.6-sol",
        health: null,
      });
      const enabled = await resolveVm0ManagedModelRouteFixture(
        context,
        "gpt-5.6-sol",
        true,
      );
      expect(enabled?.health).toStrictEqual({
        credential_generation: 0,
        candidate_generation: 0,
        credential_probe: false,
        candidate_probe: false,
        probe_lease_id: null,
      });

      const firstClaude = await resolveVm0ManagedModelRouteFixture(
        context,
        "claude-fable-5",
        true,
      );
      if (!firstClaude) {
        throw new Error("Expected a primary Claude route");
      }
      await applyVm0ManagedModelOutcomeFixture(context, firstClaude, {
        kind: "candidate_failure",
        failure_kind: "unavailable",
      });
      const firstClaudeFallback = await resolveVm0ManagedModelRouteFixture(
        context,
        "claude-fable-5",
        true,
      );
      expect(firstClaudeFallback?.provider_type).toBe("openrouter-api-key");
      if (!firstClaudeFallback) {
        throw new Error("Expected a fallback Claude route");
      }
      await applyVm0ManagedModelOutcomeFixture(context, firstClaudeFallback, {
        kind: "candidate_failure",
        failure_kind: "overload",
      });

      const secondClaude = await resolveVm0ManagedModelRouteFixture(
        context,
        "claude-opus-5",
        true,
      );
      if (!secondClaude) {
        throw new Error("Expected another primary Claude route");
      }
      await applyVm0ManagedModelOutcomeFixture(context, secondClaude, {
        kind: "candidate_failure",
        failure_kind: "unavailable",
      });
      isolatedFallback = await resolveVm0ManagedModelRouteFixture(
        context,
        "claude-opus-5",
        true,
      );
      expect(isolatedFallback?.provider_type).toBe("openrouter-api-key");

      const deepseek = await resolveVm0ManagedModelRouteFixture(
        context,
        "deepseek-v4-flash",
        true,
      );
      if (!deepseek) {
        throw new Error("Expected a primary DeepSeek route");
      }
      await applyVm0ManagedModelOutcomeFixture(context, deepseek, {
        kind: "candidate_failure",
        failure_kind: "rate_limit",
        retry_after_seconds: 1,
      });
    });

    const probeAt = startedAt + 1000;
    const concurrent = await withMockNowForTest(probeAt, async () => {
      return await Promise.all([
        resolveVm0ManagedModelRouteFixture(context, "deepseek-v4-flash", true),
        resolveVm0ManagedModelRouteFixture(context, "deepseek-v4-flash", true),
      ]);
    });
    const directProbe = concurrent.find((route) => {
      return route?.provider_type === "deepseek";
    });
    expect(
      concurrent.filter((route) => {
        return route?.health?.candidate_probe;
      }),
    ).toHaveLength(1);
    expect(directProbe?.health?.candidate_probe).toBeTruthy();
    if (!directProbe) {
      throw new Error("Expected one direct DeepSeek probe");
    }

    await withMockNowForTest(probeAt, async () => {
      await applyVm0ManagedModelOutcomeFixture(context, directProbe, {
        kind: "credential_failure",
        failure_kind: "authentication",
      });
    });
    const dualProbe = await withMockNowForTest(
      probeAt + 30 * 60 * 1000,
      async () => {
        return await resolveVm0ManagedModelRouteFixture(
          context,
          "deepseek-v4-flash",
          true,
        );
      },
    );
    expect(dualProbe?.health).toMatchObject({
      credential_generation: 1,
      candidate_generation: 1,
      credential_probe: true,
      candidate_probe: true,
    });
    expect(dualProbe?.health?.probe_lease_id).toStrictEqual(expect.any(String));
    if (!dualProbe) {
      throw new Error("Expected one dual-scope probe");
    }
    await withMockNowForTest(probeAt + 30 * 60 * 1000, async () => {
      await applyVm0ManagedModelOutcomeFixture(context, dualProbe, {
        kind: "success",
      });
      const closed = await resolveVm0ManagedModelRouteFixture(
        context,
        "deepseek-v4-flash",
        true,
      );
      expect(closed?.health).toStrictEqual({
        credential_generation: 1,
        candidate_generation: 1,
        credential_probe: false,
        candidate_probe: false,
        probe_lease_id: null,
      });
    });

    const isolatedFallbackRoute = isolatedFallback;
    if (!isolatedFallbackRoute) {
      throw new Error("Expected an isolated OpenRouter route");
    }
    await withMockNowForTest(startedAt, async () => {
      await applyVm0ManagedModelOutcomeFixture(context, isolatedFallbackRoute, {
        kind: "credential_failure",
        failure_kind: "billing",
      });
      const gpt = await resolveVm0ManagedModelRouteFixture(
        context,
        "gpt-5.6-sol",
        true,
      );
      if (!gpt) {
        throw new Error("Expected a primary GPT route");
      }
      await applyVm0ManagedModelOutcomeFixture(context, gpt, {
        kind: "candidate_failure",
        failure_kind: "timeout",
      });
      await expect(
        resolveVm0ManagedModelRouteFixture(context, "gpt-5.6-sol", true),
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
    ).resolves.toStrictEqual({
      runs: [],
    });
  });
});
