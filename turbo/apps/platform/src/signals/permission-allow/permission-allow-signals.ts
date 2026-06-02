import { command, computed, state, type Computed } from "ccstate";
import {
  permissionAccessRequestsCreateContract,
  permissionAccessRequestsListContract,
  permissionAccessRequestsResolveContract,
  zeroAgentPermissionPoliciesContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  type UserPermissionGrantAction,
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type {
  FirewallPolicies,
  FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
  permissionGrantsToFirewallPolicies,
  resolveFirewallPolicies,
} from "@vm0/connectors/firewalls";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$, searchParams$, replaceSearchParams$ } from "../route.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { accept } from "../../lib/accept.ts";
import { agentById, reloadAgentById$ } from "../agent.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const PERMISSION_ACCESS_REQUESTS_CHANGED_TOPIC =
  "permissionAccessRequestsChanged";

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

export const permissionAllowMethod$ = computed((get) => {
  return get(searchParams$).get("method") ?? null;
});

export const permissionAllowPath$ = computed((get) => {
  return get(searchParams$).get("path") ?? null;
});

export const permissionAllowAction$ = computed((get) => {
  const action = get(searchParams$).get("action");
  return action === "allow" || action === "deny" ? action : null;
});

export const permissionAllowRequestId$ = computed((get) => {
  return get(searchParams$).get("request") ?? null;
});

export const permissionAllowReason$ = computed((get) => {
  return get(searchParams$).get("reason") ?? null;
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
// Access requests
// ---------------------------------------------------------------------------

const internalRequestsReload$ = state(0);
const internalUserPermissionGrantsReload$ = state(0);

type PermissionRequestAction = "allow" | "deny";

interface MatchingPermissionAccessRequest {
  id: string;
  connectorRef: string;
  permission: string;
  action: PermissionRequestAction;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

function findMatchingPermissionRequest(
  requests: readonly MatchingPermissionAccessRequest[],
  ref: string,
  permission: string,
  action: PermissionRequestAction,
): MatchingPermissionAccessRequest | null {
  const match = requests
    .filter((r) => {
      return (
        r.connectorRef === ref &&
        r.permission === permission &&
        r.action === action &&
        (r.status === "pending" || r.status === "rejected")
      );
    })
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    });
  return match[0] ?? null;
}

/** Fetch a specific request by ID (request mode) */
export const permissionRequestById$ = computed(async (get) => {
  get(internalRequestsReload$);
  const requestId = get(permissionAllowRequestId$);
  if (!requestId) {
    return null;
  }
  const client = get(zeroClient$)(permissionAccessRequestsListContract);
  const result = await accept(client.list({ query: { requestId } }), [200]);
  return result.body[0] ?? null;
});

/** Find existing request for same agent+ref+permission (doctor mode, member redirect) */
export const permissionExistingRequest$ = computed(async (get) => {
  get(internalRequestsReload$);
  if (get(userPermissionGrantsEnabled$)) {
    return null;
  }
  const agentId = get(permissionAllowAgentId$);
  const ref = get(permissionAllowRef$);
  const permission = get(permissionAllowPermission$);
  const requestId = get(permissionAllowRequestId$);
  const action = get(permissionAllowAction$) ?? "allow";
  // Only run in doctor mode (no requestId)
  if (!agentId || !ref || !permission || requestId) {
    return null;
  }
  const client = get(zeroClient$)(permissionAccessRequestsListContract);
  const result = await accept(client.list({ query: { agentId } }), [200]);
  return findMatchingPermissionRequest(result.body, ref, permission, action);
});

interface ExistingRequestByActionParams {
  agentId: string;
  connectorRef: string;
  permission: string;
  action: PermissionRequestAction;
  enabled: boolean;
}

function createPermissionExistingRequestByActionFactory(): (
  params: ExistingRequestByActionParams,
) => Computed<Promise<MatchingPermissionAccessRequest | null>> {
  const cache = new Map<
    string,
    Computed<Promise<MatchingPermissionAccessRequest | null>>
  >();
  return (params) => {
    const key = JSON.stringify(params);
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get) => {
      get(internalRequestsReload$);
      if (!params.enabled) {
        return null;
      }
      const client = get(zeroClient$)(permissionAccessRequestsListContract);
      const result = await accept(
        client.list({ query: { agentId: params.agentId } }),
        [200],
      );
      return findMatchingPermissionRequest(
        result.body,
        params.connectorRef,
        params.permission,
        params.action,
      );
    });
    cache.set(key, atom$);
    return atom$;
  };
}

export const permissionExistingRequestByAction =
  createPermissionExistingRequestByActionFactory();

// ---------------------------------------------------------------------------
// Current-user permission grants
// ---------------------------------------------------------------------------

export const userPermissionGrantsEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.UserPermissionGrants] ?? false;
});

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
  if (!get(userPermissionGrantsEnabled$)) {
    return [];
  }
  const agentId = get(permissionAllowAgentId$);
  const requestId = get(permissionAllowRequestId$);
  if (!agentId || requestId) {
    return [];
  }
  return await listUserPermissionGrants(get, agentId);
});

interface UserPermissionGrantsByAgentParams {
  agentId: string;
  enabled: boolean;
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
      if (!params.enabled) {
        return [];
      }
      return await listUserPermissionGrants(get, params.agentId);
    });
    cache.set(key, atom$);
    return atom$;
  };
}

export const userPermissionGrantsByAgent =
  createUserPermissionGrantsByAgentFactory();

// ---------------------------------------------------------------------------
// URL: update request ID in URL
// ---------------------------------------------------------------------------

export const updateRequestIdInUrl$ = command(({ set }, requestId: string) => {
  const params = new URLSearchParams();
  params.set("request", requestId);
  set(replaceSearchParams$, params);
});

// ---------------------------------------------------------------------------
// Admin: save permission policies
// ---------------------------------------------------------------------------

const saveFirewallPolicies$ = command(
  async (
    { get, set },
    agentId: string,
    policies: FirewallPolicies,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroAgentPermissionPoliciesContract);
    await accept(client.update({ body: { agentId, policies } }), [200]);
    signal.throwIfAborted();
    set(internalAgentReload$, (prev) => {
      return prev + 1;
    });
    set(reloadAgentById$);
  },
);

// ---------------------------------------------------------------------------
// Admin: resolve (approve/reject) access request
// ---------------------------------------------------------------------------

const resolveAccessRequest$ = command(
  async (
    { get, set },
    requestId: string,
    action: "approve" | "reject",
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(permissionAccessRequestsResolveContract);
    await accept(client.resolve({ body: { requestId, action } }), [200]);
    signal.throwIfAborted();
    set(internalRequestsReload$, (prev) => {
      return prev + 1;
    });
    set(internalAgentReload$, (prev) => {
      return prev + 1;
    });
    set(reloadAgentById$);
  },
);

// ---------------------------------------------------------------------------
// Member: create access request (returns request ID)
// ---------------------------------------------------------------------------

const createAccessRequest$ = command(
  async (
    { get, set },
    params: {
      agentId: string;
      connectorRef: string;
      permission: string;
      action?: "allow" | "deny";
      method?: string;
      path?: string;
      reason?: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const client = get(zeroClient$)(permissionAccessRequestsCreateContract);
    const result = await accept(client.create({ body: params }), [201]);
    signal.throwIfAborted();
    set(internalRequestsReload$, (prev) => {
      return prev + 1;
    });
    return result.body.id;
  },
);

export const upsertUserPermissionGrant$ = command(
  async (
    { get, set },
    params: {
      agentId: string;
      connectorRef: string;
      permission: string;
      action: UserPermissionGrantAction;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroUserPermissionGrantsContract);
    await accept(
      client.upsert({
        body: {
          ...params,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalUserPermissionGrantsReload$, (prev) => {
      return prev + 1;
    });
  },
);

// ---------------------------------------------------------------------------
// UI state: focused views
// ---------------------------------------------------------------------------

const internalAdminFocusedPolicyOverride$ = state<FirewallPolicyValue | null>(
  null,
);

const internalAdminFocusedSaved$ = state(false);

interface SaveAdminFocusedPolicyParams {
  agentId: string;
  ref: string;
  permissionName: string;
  action: FirewallPolicyValue;
  agentFirewallPolicies: FirewallPolicies | null;
}

export const saveAdminFocusedPolicy$ = command(
  async (
    { get, set },
    params: SaveAdminFocusedPolicyParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const { agentId, ref, permissionName, action, agentFirewallPolicies } =
      params;
    const override = get(internalAdminFocusedPolicyOverride$);
    const policy = override ?? action;
    const existing = agentFirewallPolicies?.[ref];
    const fullPolicies: FirewallPolicies = {
      ...agentFirewallPolicies,
      [ref]: {
        ...existing,
        policies: {
          ...existing?.policies,
          [permissionName]: policy,
        },
      },
    };
    await set(saveFirewallPolicies$, agentId, fullPolicies, signal);
    toast.success(
      action === "deny" ? "Permissions denied" : "Permissions updated",
    );
    set(internalAdminFocusedSaved$, true);
  },
);

export const resolveAndUpdatePolicy$ = command(
  async (
    { set },
    requestId: string,
    resolveAction: "approve" | "reject",
    requestAction: "allow" | "deny",
    signal: AbortSignal,
  ): Promise<void> => {
    await set(resolveAccessRequest$, requestId, resolveAction, signal);
    if (resolveAction === "approve") {
      set(internalAdminFocusedPolicyOverride$, requestAction);
    }
  },
);

const internalResendFormVisible$ = state(false);

export const resendFormVisible$ = computed((get) => {
  return get(internalResendFormVisible$);
});

export const showResendForm$ = command(({ set }) => {
  set(internalResendFormVisible$, true);
  set(internalReason$, "");
});

export const resetFocusedState$ = command(({ set }) => {
  set(internalAdminFocusedPolicyOverride$, null);
  set(internalAdminFocusedSaved$, false);
  set(internalReason$, "");
  set(internalLinkCopied$, false);
  set(internalResendFormVisible$, false);
});

// ---------------------------------------------------------------------------
// UI state: member request form + copy link
// ---------------------------------------------------------------------------

const internalReason$ = state("");

export const reason$ = computed((get) => {
  return get(internalReason$);
});

export const setReason$ = command(({ set }, value: string) => {
  set(internalReason$, value);
});

const internalLinkCopied$ = state(false);

export const linkCopied$ = computed((get) => {
  return get(internalLinkCopied$);
});

export const copyLink$ = command(async ({ set }, signal: AbortSignal) => {
  const url = globalThis.location.href;
  await navigator.clipboard.writeText(url);
  signal.throwIfAborted();
  set(internalLinkCopied$, true);
  await delay(2000, { signal });
  set(internalLinkCopied$, false);
});

export const submitAccessRequest$ = command(
  async (
    { set },
    params: {
      agentId: string;
      connectorRef: string;
      permission: string;
      action?: "allow" | "deny";
      method?: string;
      path?: string;
      reason?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const requestId = await set(createAccessRequest$, params, signal);
    set(internalReason$, "");
    set(updateRequestIdInUrl$, requestId);
  },
);

const reloadPermissionAccessRequests$ = command(({ set }) => {
  set(internalRequestsReload$, (prev) => {
    return prev + 1;
  });
  set(internalAgentReload$, (prev) => {
    return prev + 1;
  });
  set(reloadAgentById$);
});

export const subscribePermissionAccessRequestsChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadPermissionAccessRequests$);
      return false;
    });
    await set(
      setAblyLoop$,
      PERMISSION_ACCESS_REQUESTS_CHANGED_TOPIC,
      onChanged$,
      signal,
    );
  },
);
