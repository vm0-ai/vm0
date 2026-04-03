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
import { delay } from "signal-timers";
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

export const firewallAllowAction$ = computed((get) => {
  const action = get(searchParams$).get("action");
  return action === "allow" || action === "deny" ? action : null;
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

export const firewallLatestRequest$ = computed(async (get) => {
  get(internalRequestsReload$);
  const agentId = get(firewallAllowAgentId$);
  const ref = get(firewallAllowRef$);
  if (!agentId || !ref) {
    return null;
  }

  const client = get(zeroClient$)(firewallAccessRequestsListContract);
  const result = await accept(
    client.list({ query: { agentId } }),
    [200],
    { toast: false },
  );

  // Filter to this firewall ref, return latest by createdAt
  const filtered = result.body
    .filter((r) => {
      return r.firewallRef === ref;
    })
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    });
  return filtered[0] ?? null;
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

const internalResolvedAction$ = state<"approve" | "reject" | null>(null);

export const resolvedAction$ = computed((get) => {
  return get(internalResolvedAction$);
});

export const resetAdminFocusedState$ = command(({ set }) => {
  set(internalAdminFocusedPolicyOverride$, null);
  set(internalAdminFocusedSaved$, false);
  set(internalResolvedAction$, null);
});

const internalAdminFocusedSaved$ = state(false);

const internalResolvingId$ = state<string | null>(null);

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
      set(internalResolvedAction$, action);
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

const internalReason$ = state("");

export const showForm$ = computed((get) => {
  return get(internalShowForm$);
});

export const setShowForm$ = command(({ set }, value: boolean) => {
  set(internalShowForm$, value);
});

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

export const resetMemberFocusedState$ = command(({ set }) => {
  set(internalShowForm$, false);
  set(internalReason$, "");
  set(internalLinkCopied$, false);
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
