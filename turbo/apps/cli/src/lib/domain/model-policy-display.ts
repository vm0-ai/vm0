import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
  type OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";

type ModelProviderRouteKind = "built-in" | "api key" | "subscription";

export function getModelProviderRouteKind(
  policy: Pick<OrgModelPolicy, "credentialScope" | "defaultProviderType">,
): ModelProviderRouteKind {
  if (policy.defaultProviderType === "vm0") {
    return "built-in";
  }

  if (policy.credentialScope === "member") {
    return "subscription";
  }

  return "api key";
}

export function getModelProviderTypeLabel(type: ModelProviderType): string {
  return MODEL_PROVIDER_TYPES[type].label;
}

export function formatModelProviderRoute(policy: OrgModelPolicy): string {
  const kind = getModelProviderRouteKind(policy);
  const label = getModelProviderTypeLabel(policy.defaultProviderType);
  return `${kind} (${label}; ${policy.defaultProviderType})`;
}

export function formatModelPolicyStatus(policy: OrgModelPolicy): string | null {
  if (policy.routeStatus === "valid") {
    return null;
  }

  return policy.routeStatusReason
    ? `${policy.routeStatus}: ${policy.routeStatusReason}`
    : policy.routeStatus;
}
