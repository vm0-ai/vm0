import { command } from "ccstate";
import type { FirewallPolicies } from "@vm0/connectors/firewall-types";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { zeroAgentPermissionPoliciesContract } from "@vm0/api-contracts/contracts/zero-agents";

import { isNotFoundResponse } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { updateAgentPermissionPolicies$ } from "../services/zero-permission-policies.service";

function validatePolicies(policies: FirewallPolicies): string | null {
  for (const [ref, policy] of Object.entries(policies)) {
    if (!isFirewallConnectorType(ref)) {
      return `Unknown connector ref: ${ref}`;
    }
    const config = getConnectorFirewall(ref);
    const validPermNames = new Set<string>();
    for (const api of config.apis) {
      if (api.permissions) {
        for (const p of api.permissions) {
          validPermNames.add(p.name);
        }
      }
    }
    for (const permName of Object.keys(policy.policies)) {
      if (!validPermNames.has(permName)) {
        return `Unknown permission "${permName}" for connector "${ref}"`;
      }
    }
  }
  return null;
}

function validationError(message: string) {
  return {
    status: 400 as const,
    body: {
      error: { message, code: "VALIDATION_ERROR" },
    },
  };
}

const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const bodyResult = await get(
    bodyResultOf(zeroAgentPermissionPoliciesContract.update),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validationMessage = validatePolicies(bodyResult.data.policies);
  if (validationMessage) {
    return validationError(validationMessage);
  }

  const result = await set(
    updateAgentPermissionPolicies$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      role: auth.orgRole ?? "member",
      agentId: bodyResult.data.agentId,
      policies: bodyResult.data.policies,
    },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }
  if ("status" in result && result.status === 403) {
    return result;
  }

  return { status: 200 as const, body: result.agent };
});

export const zeroPermissionPoliciesRoutes: readonly RouteEntry[] = [
  {
    route: zeroAgentPermissionPoliciesContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:write",
      },
      updateInner$,
    ),
  },
];
