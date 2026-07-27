import { command, computed, state } from "ccstate";
import type {
  ModelProviderResponse,
  ModelProviderType,
  OrgModelPoliciesResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import {
  personalModelProviders$,
  reloadPersonalModelProviders$,
} from "../external/personal-model-providers.ts";
import {
  modelPlanCapabilities$,
  modelPolicyAllowedForPlan,
} from "./model-plan-capabilities.ts";

type PersonalOauthProviderType =
  | "claude-code-oauth-token"
  | "codex-oauth-token";

type PersonalModelProviderStatus =
  | {
      status: "connected";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
    }
  | {
      status: "missing";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
    }
  | {
      status: "needs_reconnect";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
    };

type PersonalModelProviderStatusByModel = Readonly<
  Record<string, PersonalModelProviderStatus>
>;

const internalReloadPersonalModelProvider$ = state(0);

export const reloadPersonalModelProvider$ = command(({ set }) => {
  set(reloadPersonalModelProviders$);
  set(internalReloadPersonalModelProvider$, (value) => {
    return value + 1;
  });
});

function isPersonalOauthProviderType(
  type: ModelProviderType,
): type is PersonalOauthProviderType {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function personalStatusForPolicy(
  policy: OrgModelPoliciesResponse["policies"][number],
  personalProviders: readonly ModelProviderResponse[],
): PersonalModelProviderStatus | null {
  if (
    policy.credentialScope !== "member" ||
    !isPersonalOauthProviderType(policy.defaultProviderType)
  ) {
    return null;
  }

  const provider = personalProviders.find((candidate) => {
    return candidate.type === policy.defaultProviderType;
  });
  return {
    providerType: policy.defaultProviderType,
    modelLabel: policy.modelLabel,
    status: !provider
      ? "missing"
      : provider.needsReconnect
        ? "needs_reconnect"
        : "connected",
  };
}

export const personalModelProvider$ = computed(
  async (get): Promise<PersonalModelProviderStatusByModel> => {
    get(internalReloadPersonalModelProvider$);
    const [policies, personal] = await Promise.all([
      get(orgModelPolicies$),
      get(personalModelProviders$),
    ]);

    const statuses: Record<string, PersonalModelProviderStatus> = {};
    for (const policy of policies.policies) {
      const status = personalStatusForPolicy(policy, personal.modelProviders);
      if (status) {
        statuses[policy.model] = status;
      }
    }
    return statuses;
  },
);

export const selectedModelAvailable$ = command(
  async (
    { get },
    selectedModel: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [policies, modelCapabilities] = await Promise.all([
      get(orgModelPolicies$),
      get(modelPlanCapabilities$),
    ]);
    signal.throwIfAborted();
    const policy = policies.policies.find((candidate) => {
      return candidate.model === selectedModel;
    });
    if (policy === undefined || policy.routeStatus !== "valid") {
      return false;
    }
    if (!modelPolicyAllowedForPlan(policy, modelCapabilities)) {
      return false;
    }
    if (
      policy.credentialScope !== "member" ||
      !isPersonalOauthProviderType(policy.defaultProviderType)
    ) {
      return true;
    }
    const status = (await get(personalModelProvider$))[selectedModel];
    signal.throwIfAborted();
    return status?.status === "connected";
  },
);
