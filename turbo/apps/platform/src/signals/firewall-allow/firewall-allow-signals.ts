import { command, computed, state } from "ccstate";
import {
  firewallAccessRequestsCreateContract,
  firewallAccessRequestsListContract,
  firewallAccessRequestsResolveContract,
  zeroAgentFirewallPoliciesContract,
  zeroAgentsByIdContract,
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

export const firewallAllowAgentId$ = computed((get) => {
  const params = get(pathParams$);
  const id = params?.id;
  return typeof id === "string" ? id : null;
});

export const firewallAllowRef$ = computed((get) => {
  return get(searchParams$).get("ref") ?? null;
});

export const firewallAllowPermission$ = computed((get) => {
  return get(searchParams$).get("permission") ?? null;
});

export const firewallAllowMethod$ = computed((get) => {
  return get(searchParams$).get("method") ?? null;
});

export const firewallAllowPath$ = computed((get) => {
  return get(searchParams$).get("path") ?? null;
});

// ---------------------------------------------------------------------------
// Agent data
// ---------------------------------------------------------------------------

const internalAgentReload$ = state(0);

export const firewallAllowAgent$ = computed(async (get) => {
  get(internalAgentReload$);
  const agentId = get(firewallAllowAgentId$);
  if (!agentId) {
    return null;
  }
  const client = get(zeroClient$)(zeroAgentsByIdContract);
  const result = await accept(client.get({ params: { id: agentId } }), [200], {
    toast: false,
  });
  return result.body;
});

// ---------------------------------------------------------------------------
// Permissions list (derived from firewall config)
// ---------------------------------------------------------------------------

interface FirewallPermission {
  name: string;
  description?: string;
}

export function extractPermissions(ref: string): FirewallPermission[] {
  if (!isFirewallConnectorType(ref)) {
    return [];
  }
  const config = getConnectorFirewall(ref);
  const seen = new Map<string, FirewallPermission>();
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

export const firewallAccessRequests$ = computed(async (get) => {
  get(internalRequestsReload$);
  const agentId = get(firewallAllowAgentId$);
  const ref = get(firewallAllowRef$);
  if (!agentId || !ref) {
    return [];
  }

  const client = get(zeroClient$)(firewallAccessRequestsListContract);
  const result = await accept(
    client.list({ query: { agentId, status: "pending" } }),
    [200],
    { toast: false },
  );

  // Filter to only requests for this firewall ref
  return result.body.filter((r) => {
    return r.firewallRef === ref;
  });
});

// ---------------------------------------------------------------------------
// Admin: save firewall policies
// ---------------------------------------------------------------------------

const saveFirewallPolicies$ = command(
  async (
    { get, set },
    agentId: string,
    policies: FirewallPolicies,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroAgentFirewallPoliciesContract);
    await accept(client.update({ body: { agentId, policies } }), [200]);
    signal.throwIfAborted();
    set(internalAgentReload$, (prev) => {
      return prev + 1;
    });
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
    const client = get(zeroClient$)(firewallAccessRequestsResolveContract);
    await accept(client.resolve({ body: { requestId, action } }), [200]);
    signal.throwIfAborted();
    set(internalRequestsReload$, (prev) => {
      return prev + 1;
    });
    set(internalAgentReload$, (prev) => {
      return prev + 1;
    });
  },
);

// ---------------------------------------------------------------------------
// Member: create access request
// ---------------------------------------------------------------------------

const createAccessRequest$ = command(
  async (
    { get, set },
    params: {
      agentId: string;
      firewallRef: string;
      permission: string;
      method?: string;
      path?: string;
      reason?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(firewallAccessRequestsCreateContract);
    await accept(client.create({ body: params }), [201]);
    signal.throwIfAborted();
    set(internalRequestsReload$, (prev) => {
      return prev + 1;
    });
  },
);

// ---------------------------------------------------------------------------
// UI state: AdminFocusedView
// ---------------------------------------------------------------------------

const internalAdminFocusedPolicyOverride$ = state<FirewallPolicyValue | null>(
  null,
);

export const adminFocusedPolicy$ = computed((get) => {
  return get(internalAdminFocusedPolicyOverride$);
});

export const setAdminFocusedPolicy$ = command(
  ({ set }, value: FirewallPolicyValue) => {
    set(internalAdminFocusedPolicyOverride$, value);
    set(internalAdminFocusedSaved$, false);
  },
);

export const resetAdminFocusedState$ = command(({ set }) => {
  set(internalAdminFocusedPolicyOverride$, null);
  set(internalAdminFocusedSaved$, false);
});

const internalAdminFocusedSaved$ = state(false);

export const adminFocusedSaved$ = computed((get) => {
  return get(internalAdminFocusedSaved$);
});

const internalResolvingId$ = state<string | null>(null);

export const resolvingId$ = computed((get) => {
  return get(internalResolvingId$);
});

interface SaveAdminFocusedPolicyParams {
  agentId: string;
  ref: string;
  permissionName: string;
  agentFirewallPolicies: FirewallPolicies | null;
}

export const saveAdminFocusedPolicy$ = command(
  async (
    { get, set },
    params: SaveAdminFocusedPolicyParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const { agentId, ref, permissionName, agentFirewallPolicies } = params;
    const override = get(internalAdminFocusedPolicyOverride$);
    const defaults = isFirewallConnectorType(ref)
      ? getDefaultFirewallPolicies(ref)
      : null;
    const policy =
      override ??
      agentFirewallPolicies?.[ref]?.[permissionName] ??
      defaults?.[permissionName] ??
      "allow";
    const fullPolicies: FirewallPolicies = {
      ...agentFirewallPolicies,
      [ref]: {
        ...agentFirewallPolicies?.[ref],
        [permissionName]: policy,
      },
    };
    await set(saveFirewallPolicies$, agentId, fullPolicies, signal);
    set(internalAdminFocusedSaved$, true);
  },
);

export const resolveAndUpdatePolicy$ = command(
  async (
    { set },
    requestId: string,
    action: "approve" | "reject",
    signal: AbortSignal,
  ): Promise<void> => {
    set(internalResolvingId$, requestId);
    try {
      await set(resolveAccessRequest$, requestId, action, signal);
      if (action === "approve") {
        set(internalAdminFocusedPolicyOverride$, "allow");
      }
    } finally {
      set(internalResolvingId$, null);
    }
  },
);

// ---------------------------------------------------------------------------
// UI state: MemberFocusedView
// ---------------------------------------------------------------------------

const internalShowForm$ = state(false);

export const showForm$ = computed((get) => {
  return get(internalShowForm$);
});

export const setShowForm$ = command(({ set }, value: boolean) => {
  set(internalShowForm$, value);
  if (!value) {
    set(internalReason$, "");
  }
});

const internalReason$ = state("");

export const reason$ = computed((get) => {
  return get(internalReason$);
});

export const setReason$ = command(({ set }, value: string) => {
  set(internalReason$, value);
});

export const resetMemberFocusedState$ = command(({ set }) => {
  set(internalShowForm$, false);
  set(internalReason$, "");
});

export const submitAccessRequest$ = command(
  async (
    { set },
    params: {
      agentId: string;
      firewallRef: string;
      permission: string;
      method?: string;
      path?: string;
      reason?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(createAccessRequest$, params, signal);
    set(internalShowForm$, false);
    set(internalReason$, "");
  },
);

// ---------------------------------------------------------------------------
// UI state: AdminListView
// ---------------------------------------------------------------------------

const internalAdminListPolicyOverrides$ = state<
  Record<string, FirewallPolicyValue>
>({});

const internalAdminListInitKey$ = state("");

export const adminListPolicies$ = computed((get) => {
  return get(internalAdminListPolicyOverrides$);
});

export const syncAdminListPolicies$ = command(
  (
    { get, set },
    permissions: FirewallPermission[],
    ref: string,
    agentFirewallPolicies: FirewallPolicies | null,
  ) => {
    const key = `${ref}:${JSON.stringify(agentFirewallPolicies?.[ref])}`;
    if (get(internalAdminListInitKey$) === key) {
      return;
    }
    set(internalAdminListInitKey$, key);
    const defaults = isFirewallConnectorType(ref)
      ? getDefaultFirewallPolicies(ref)
      : null;
    const result: Record<string, FirewallPolicyValue> = {};
    for (const p of permissions) {
      result[p.name] =
        agentFirewallPolicies?.[ref]?.[p.name] ?? defaults?.[p.name] ?? "allow";
    }
    set(internalAdminListPolicyOverrides$, result);
  },
);

export const setAdminListPolicy$ = command(
  ({ set }, permissionName: string, value: FirewallPolicyValue) => {
    set(internalAdminListPolicyOverrides$, (prev) => {
      return { ...prev, [permissionName]: value };
    });
  },
);

export const setAdminListGroupPolicies$ = command(
  ({ set }, permissionNames: string[], value: FirewallPolicyValue) => {
    set(internalAdminListPolicyOverrides$, (prev) => {
      const next = { ...prev };
      for (const name of permissionNames) {
        next[name] = value;
      }
      return next;
    });
  },
);

export const saveAdminListPolicies$ = command(
  async (
    { get, set },
    agentId: string,
    agentFirewallPolicies: FirewallPolicies | null,
    ref: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const policies = get(internalAdminListPolicyOverrides$);
    const fullPolicies: FirewallPolicies = {
      ...agentFirewallPolicies,
      [ref]: policies,
    };
    await set(saveFirewallPolicies$, agentId, fullPolicies, signal);
  },
);
