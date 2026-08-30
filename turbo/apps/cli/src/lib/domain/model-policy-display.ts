import {
  getModelProviderPresentationLabel,
  isBuiltInModelProviderType,
  type ModelProviderType,
  type OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";

type ModelProviderRouteKind = "built-in" | "api key" | "subscription";

export function getModelProviderRouteKind(
  policy: Pick<OrgModelPolicy, "credentialScope" | "defaultProviderType">,
): ModelProviderRouteKind {
  if (isBuiltInModelProviderType(policy.defaultProviderType)) {
    return "built-in";
  }

  if (policy.credentialScope === "member") {
    return "subscription";
  }

  return "api key";
}

export function getModelProviderTypeLabel(type: ModelProviderType): string {
  return getModelProviderPresentationLabel(type);
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
