import { command, computed, state, type Computed } from "ccstate";
import {
  type UserPermissionGrantExpiresIn,
  type UserPermissionGrantAction,
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
  permissionGrantsToFirewallPolicies,
  resolveFirewallPolicies,
} from "@vm0/connectors/firewalls";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { agentById, reloadAgentById$ } from "../agent.ts";
import { parseUserPermissionGrantExpiresIn } from "./permission-grant-expiration.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

export const permissionAllowAgentId$ = computed((get) => {
  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
});

export const permissionAllowRef$ = computed((get) => {
  return get(searchParams$).get("ref") ?? null;
});

export const permissionAllowPermission$ = computed((get) => {
  return get(searchParams$).get("permission") ?? null;
});

export const permissionAllowAction$ = computed((get) => {
  const action = get(searchParams$).get("action");
  return action === "allow" || action === "deny" ? action : null;
});

export const permissionAllowExpiresIn$ = computed((get) => {
  return parseUserPermissionGrantExpiresIn(get(searchParams$).get("expiresIn"));
});

// ---------------------------------------------------------------------------
// Agent data
// ---------------------------------------------------------------------------

const internalAgentReload$ = state(0);

export const permissionAllowAgent$ = computed((get) => {
  get(internalAgentReload$);
  const agentId = get(permissionAllowAgentId$);
  if (!agentId) {
    return null;
  }
  return get(agentById(agentId));
});

// ---------------------------------------------------------------------------
// Permissions list (derived from connector config)
// ---------------------------------------------------------------------------

interface Permission {
  name: string;
  description?: string;
}

export function extractPermissions(ref: string): Permission[] {
  if (!isFirewallConnectorType(ref)) {
    return [];
  }
  const config = getConnectorFirewall(ref);
  const seen = new Map<string, Permission>();
  for (const api of config.apis) {
    if (!api.permissions) {
      continue;
    }
    for (const p of api.permissions) {
      if (!seen.has(p.name)) {
        seen.set(p.name, { name: p.name, description: p.description });
      }
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Current-user permission grants
// ---------------------------------------------------------------------------

const internalUserPermissionGrantsReload$ = state(0);

export function resolveUserPermissionGrantPolicy(
  grants: readonly UserPermissionGrantResponse[],
  connectorRef: string,
  permission: string,
): FirewallPolicyValue | undefined {
  return resolveFirewallPolicies(permissionGrantsToFirewallPolicies(grants), [
    connectorRef,
  ])?.[connectorRef]?.policies[permission];
}

async function listUserPermissionGrants(
  get: <T>(atom: Computed<T>) => T,
  agentId: string,
): Promise<readonly UserPermissionGrantResponse[]> {
  const client = get(zeroClient$)(zeroUserPermissionGrantsContract);
  const result = await accept(client.list({ query: { agentId } }), [200]);
  return result.body;
}

export const permissionAllowUserPermissionGrants$ = computed(async (get) => {
  get(internalUserPermissionGrantsReload$);
  const agentId = get(permissionAllowAgentId$);
  if (!agentId) {
    return [];
  }
  return await listUserPermissionGrants(get, agentId);
});

interface UserPermissionGrantsByAgentParams {
  agentId: string;
}

function createUserPermissionGrantsByAgentFactory(): (
  params: UserPermissionGrantsByAgentParams,
) => Computed<Promise<readonly UserPermissionGrantResponse[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly UserPermissionGrantResponse[]>>
  >();
  return (params) => {
    const key = JSON.stringify(params);
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get) => {
      get(internalUserPermissionGrantsReload$);
      return await listUserPermissionGrants(get, params.agentId);
    });
    cache.set(key, atom$);
    return atom$;
  };
}

export const userPermissionGrantsByAgent =
  createUserPermissionGrantsByAgentFactory();

export const upsertUserPermissionGrant$ = command(
  async (
    { get, set },
    params: {
      agentId: string;
      connectorRef: string;
      permission: string;
      action: UserPermissionGrantAction;
      expiresIn?: UserPermissionGrantExpiresIn;
    },
    signal: AbortSignal,
  ): Promise<UserPermissionGrantResponse> => {
    const client = get(zeroClient$)(zeroUserPermissionGrantsContract);
    const body =
      params.action === "allow"
        ? {
            agentId: params.agentId,
            connectorRef: params.connectorRef,
            permission: params.permission,
            action: "allow" as const,
            ...(params.expiresIn ? { expiresIn: params.expiresIn } : {}),
          }
        : {
            agentId: params.agentId,
            connectorRef: params.connectorRef,
            permission: params.permission,
            action: "deny" as const,
          };
    const result = await accept(
      client.upsert({
        body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalUserPermissionGrantsReload$, (prev) => {
      return prev + 1;
    });
    set(internalAgentReload$, (prev) => {
      return prev + 1;
    });
    set(reloadAgentById$);
    return result.body;
  },
);
