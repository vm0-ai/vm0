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

export type PersonalOauthProviderType =
  | "claude-code-oauth-token"
  | "codex-oauth-token";

export type PersonalModelProviderStatus =
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

type PersonalModelProviderWarningKind =
  | "claude-code-connect"
  | "claude-code-reconnect"
  | "codex-connect"
  | "codex-reconnect";

export type PersonalModelProviderWarning =
  `${PersonalModelProviderWarningKind}\0${string}`;

export type PersonalModelProviderStatusByModel = Readonly<
  Record<string, PersonalModelProviderStatus>
>;

export function personalModelProviderWarning(
  status: PersonalModelProviderStatus | null | undefined,
): PersonalModelProviderWarning | null {
  if (!status || status.status === "connected") {
    return null;
  }
  let kind: PersonalModelProviderWarningKind;
  if (status.providerType === "codex-oauth-token") {
    kind =
      status.status === "needs_reconnect" ? "codex-reconnect" : "codex-connect";
  } else {
    kind =
      status.status === "needs_reconnect"
        ? "claude-code-reconnect"
        : "claude-code-connect";
  }
  return `${kind}\0${status.modelLabel}`;
}

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
