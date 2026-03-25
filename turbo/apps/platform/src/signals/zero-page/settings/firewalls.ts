import { command } from "ccstate";
import type {
  ConnectorType,
  FirewallPolicies,
  FirewallPolicyValue,
} from "@vm0/core";
import { fetch$ } from "../../fetch.ts";

/**
 * Maps platform connector types to their firewall ref name(s) in builtinFirewalls.
 * Only includes connectors that have builtin firewall configs available.
 */
const FIREWALL_CONNECTOR_MAP: Readonly<
  Partial<Record<ConnectorType, readonly string[]>>
> = {
  github: ["github"],
  slack: ["slack"],
  gmail: ["gmail"],
  "google-sheets": ["google-sheets"],
  "google-docs": ["google-docs"],
  "google-drive": ["google-drive"],
  "google-calendar": ["google-calendar"],
  atlassian: ["jira", "confluence"],
} as const;

/** Check if a connector type has firewall config(s) available. */
export function hasFirewallConfig(type: ConnectorType): boolean {
  return type in FIREWALL_CONNECTOR_MAP;
}

/** Get the firewall ref names for a connector type. */
export function getFirewallRefs(type: ConnectorType): string[] {
  return [...(FIREWALL_CONNECTOR_MAP[type] ?? [])];
}

// ---------------------------------------------------------------------------
// Permission policy: allow | deny | ask
// ---------------------------------------------------------------------------

export type PermissionPolicy = FirewallPolicyValue;

/**
 * Persist firewall policies to the backend for an agent.
 */
export const saveFirewallPolicies$ = command(
  async (
    { get },
    agentName: string,
    policies: FirewallPolicies,
  ): Promise<FirewallPolicies | null> => {
    const fetchFn = get(fetch$);

    const resp = await fetchFn("/api/zero/firewall-policies", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agentName, policies }),
    });

    if (!resp.ok) {
      const parsed: unknown = await resp.json().catch(() => null);
      let detail = resp.statusText;
      if (
        parsed !== null &&
        parsed !== undefined &&
        typeof parsed === "object" &&
        "error" in parsed &&
        parsed.error !== null &&
        parsed.error !== undefined &&
        typeof parsed.error === "object" &&
        "message" in parsed.error &&
        typeof parsed.error.message === "string"
      ) {
        detail = parsed.error.message;
      }
      throw new Error(`Save failed: ${detail}`);
    }

    const data = (await resp.json()) as {
      firewallPolicies?: FirewallPolicies | null;
    };
    return data.firewallPolicies ?? null;
  },
);
