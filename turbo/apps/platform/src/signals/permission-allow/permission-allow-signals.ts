import { command, computed, state, type Computed } from "ccstate";
import {
  type UserPermissionGrantExpiresIn,
  type UserPermissionGrantAction,
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import {
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { agentById, reloadAgentById$ } from "../agent.ts";
import { retryAsync } from "../utils.ts";
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

export const permissionAllowActionParam$ = computed((get) => {
  return get(searchParams$).get("action");
});

export const permissionAllowAction$ = computed((get) => {
  const action = get(permissionAllowActionParam$);
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
// Permissions list (derived from firewall metadata)
// ---------------------------------------------------------------------------

export interface Permission {
  name: string;
  description?: string;
}

export function findPermissionInMetadata(
  metadata: FirewallPermissionDetailMetadata,
  name: string,
): Permission | null {
  if (name === UNKNOWN_PERMISSION_GRANT) {
    return {
      name: UNKNOWN_PERMISSION_GRANT,
      description: "Unknown endpoints",
    };
  }
  return (
    metadata.permissions.find((permission) => {
      return permission.name === name;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Current-user permission grants
// ---------------------------------------------------------------------------

const internalUserPermissionGrantsReload$ = state(0);

export function resolveUserPermissionGrantPolicy(
  grants: readonly UserPermissionGrantResponse[],
  metadata: FirewallPermissionDetailMetadata,
  permission: string,
): FirewallPolicyValue | undefined {
  const policies = resolveFirewallMetadataPolicies(
    permissionGrantsToFirewallPolicies(grants),
    [metadata],
  )?.[metadata.type];
  return permission === UNKNOWN_PERMISSION_GRANT
    ? policies?.unknownPolicy
    : policies?.policies[permission];
}

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
      const client = get(zeroClient$)(zeroUserPermissionGrantsContract);
      const result = await retryAsync(() => {
        return accept(
          client.list({ query: { agentId: params.agentId } }),
          [200],
          { toast: false },
        );
      });
      return result.body;
    });
    cache.set(key, atom$);
    return atom$;
  };
}

export const userPermissionGrantsByAgent =
  createUserPermissionGrantsByAgentFactory();

export const permissionAllowUserPermissionGrants$ = computed(async (get) => {
  const agentId = get(permissionAllowAgentId$);
  if (!agentId) {
    return [];
  }
  return await get(userPermissionGrantsByAgent({ agentId }));
});

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

export const resetUserPermissionGrants$ = command(
  async (
    { get, set },
    params: {
      agentId: string;
      connectorRef: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroUserPermissionGrantsContract);
    await accept(
      client.reset({
        query: {
          agentId: params.agentId,
          connectorRef: params.connectorRef,
        },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(internalUserPermissionGrantsReload$, (prev) => {
      return prev + 1;
    });
    set(internalAgentReload$, (prev) => {
      return prev + 1;
    });
    set(reloadAgentById$);
  },
);
