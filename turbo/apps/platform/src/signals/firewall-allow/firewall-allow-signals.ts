import { command, computed, state } from "ccstate";
import {
  firewallAccessRequestsCreateContract,
  firewallAccessRequestsListContract,
  firewallAccessRequestsResolveContract,
  zeroAgentFirewallPoliciesContract,
  zeroAgentsByIdContract,
  getConnectorFirewall,
  isFirewallConnectorType,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/core";
import { delay } from "signal-timers";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$, searchParams$, replaceSearchParams$ } from "../route.ts";
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

export const firewallAllowRequestId$ = computed((get) => {
  return get(searchParams$).get("request") ?? null;
});

export const firewallAllowReason$ = computed((get) => {
  return get(searchParams$).get("reason") ?? null;
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

/** Fetch a specific request by ID (request mode) */
export const firewallRequestById$ = computed(async (get) => {
  get(internalRequestsReload$);
  const requestId = get(firewallAllowRequestId$);
  if (!requestId) {
    return null;
  }
  const client = get(zeroClient$)(firewallAccessRequestsListContract);
  const result = await accept(client.list({ query: { requestId } }), [200], {
    toast: false,
  });
  return result.body[0] ?? null;
});

/** Find existing request for same agent+ref+permission (doctor mode, member redirect) */
export const firewallExistingRequest$ = computed(async (get) => {
  get(internalRequestsReload$);
  const agentId = get(firewallAllowAgentId$);
  const ref = get(firewallAllowRef$);
  const permission = get(firewallAllowPermission$);
  const requestId = get(firewallAllowRequestId$);
  const action = get(firewallAllowAction$) ?? "allow";
  // Only run in doctor mode (no requestId)
  if (!agentId || !ref || !permission || requestId) {
    return null;
  }
  const client = get(zeroClient$)(firewallAccessRequestsListContract);
  const result = await accept(client.list({ query: { agentId } }), [200], {
    toast: false,
  });
  // Find latest pending/rejected request for this ref+permission+action
  const match = result.body
    .filter((r) => {
      return (
        r.firewallRef === ref &&
        r.permission === permission &&
        r.action === action &&
        (r.status === "pending" || r.status === "rejected")
      );
    })
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    });
  return match[0] ?? null;
});

// ---------------------------------------------------------------------------
// URL: update request ID in URL
// ---------------------------------------------------------------------------

export const updateRequestIdInUrl$ = command(({ set }, requestId: string) => {
  const params = new URLSearchParams();
  params.set("request", requestId);
  set(replaceSearchParams$, params);
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
// Member: create access request (returns request ID)
// ---------------------------------------------------------------------------

const createAccessRequest$ = command(
  async (
    { get, set },
    params: {
      agentId: string;
      firewallRef: string;
      permission: string;
      action?: "allow" | "deny";
      method?: string;
      path?: string;
      reason?: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const client = get(zeroClient$)(firewallAccessRequestsCreateContract);
    const result = await accept(client.create({ body: params }), [201]);
    signal.throwIfAborted();
    set(internalRequestsReload$, (prev) => {
      return prev + 1;
    });
    return result.body.id;
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
      firewallRef: string;
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
