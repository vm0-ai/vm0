import {
  getCanonicalModelDisplayName,
  getDefaultOrgModelPolicySeed,
  type OrgModelPolicy,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { mockApi } from "../msw-contract.ts";

function policyId(index: number): string {
  return `00000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`;
}

function makeDefaultPolicies(): OrgModelPolicy[] {
  const now = "2026-05-08T00:00:00.000Z";
  return getDefaultOrgModelPolicySeed().map((seed, index) => {
    return {
      id: policyId(index),
      model: seed.model,
      modelLabel: getCanonicalModelDisplayName(seed.model),
      isDefault: seed.isDefault,
      defaultProviderType: seed.defaultProviderType,
      credentialScope: seed.credentialScope,
      modelProviderId: seed.modelProviderId,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

let mockOrgModelPolicies: OrgModelPolicy[] = makeDefaultPolicies();

function response(): OrgModelPoliciesResponse {
  const policies = [...mockOrgModelPolicies];
  const workspaceDefault =
    policies.find((policy) => {
      return policy.isDefault;
    }) ?? null;
  return {
    policies,
    workspaceDefaultModel: workspaceDefault?.model ?? null,
    workspaceDefaultPolicyId: workspaceDefault?.id ?? null,
  };
}

export function resetMockOrgModelPolicies(): void {
  mockOrgModelPolicies = makeDefaultPolicies();
}

function applyUpdate(policy: UpdateOrgModelPolicy): OrgModelPolicy {
  const existing = mockOrgModelPolicies.find((item) => {
    return item.model === policy.model;
  });
  return {
    id: existing?.id ?? crypto.randomUUID(),
    model: policy.model,
    modelLabel: getCanonicalModelDisplayName(policy.model),
    isDefault: policy.isDefault,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export const apiOrgModelPoliciesHandlers = [
  mockApi(zeroModelPoliciesMainContract.list, ({ respond }) => {
    return respond(200, response());
  }),

  mockApi(zeroModelPoliciesMainContract.update, ({ body, respond }) => {
    mockOrgModelPolicies = body.policies.map(applyUpdate);
    return respond(200, response());
  }),
];
