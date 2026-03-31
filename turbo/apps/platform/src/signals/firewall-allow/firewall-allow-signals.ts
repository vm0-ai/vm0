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
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$, searchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

export const firewallAllowAgentId$ = computed((get) => {
  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
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
  const result = await client.get({ params: { id: agentId } });
  if (result.status !== 200) {
    throw new Error(`Failed to fetch agent (${result.status})`);
  }
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
  const result = await client.list({
    query: { agentId, status: "pending" },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to fetch access requests (${result.status})`);
  }

  // Filter to only requests for this firewall ref
  return result.body.filter((r) => r.firewallRef === ref);
});

// ---------------------------------------------------------------------------
// Admin: save firewall policies
// ---------------------------------------------------------------------------

export const saveFirewallPolicies$ = command(
  async (
    { get, set },
    agentId: string,
    policies: FirewallPolicies,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroAgentFirewallPoliciesContract);
    const result = await client.update({
      body: { agentId, policies },
    });
    signal.throwIfAborted();
    if (result.status !== 200) {
      const detail =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Save failed: ${detail}`);
    }
    set(internalAgentReload$, (prev) => prev + 1);
  },
);

// ---------------------------------------------------------------------------
// Admin: resolve (approve/reject) access request
// ---------------------------------------------------------------------------

export const resolveAccessRequest$ = command(
  async (
    { get, set },
    requestId: string,
    action: "approve" | "reject",
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(firewallAccessRequestsResolveContract);
    const result = await client.resolve({
      body: { requestId, action },
    });
    signal.throwIfAborted();
    if (result.status !== 200) {
      const detail =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Resolve failed: ${detail}`);
    }
    set(internalRequestsReload$, (prev) => prev + 1);
    set(internalAgentReload$, (prev) => prev + 1);
  },
);

// ---------------------------------------------------------------------------
// Member: create access request
// ---------------------------------------------------------------------------

export const createAccessRequest$ = command(
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
    const result = await client.create({
      body: params,
    });
    signal.throwIfAborted();
    if (result.status !== 201) {
      const detail =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Request failed: ${detail}`);
    }
    set(internalRequestsReload$, (prev) => prev + 1);
  },
);
