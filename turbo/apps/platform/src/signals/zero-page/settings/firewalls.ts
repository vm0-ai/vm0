import { command, computed, state } from "ccstate";
import {
  buildFirewallYamlUrl,
  firewallConfigSchema,
  type ConnectorType,
  type FirewallConfig,
} from "@vm0/core";
import { parse as parseYaml } from "yaml";

/**
 * Maps platform connector types to their firewall ref name(s) in vm0-firewalls.
 * Most connector types map 1:1 by name. Atlassian maps to both jira and confluence.
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
  notion: ["notion"],
  vercel: ["vercel"],
  figma: ["figma"],
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
// Cached firewall config fetching
// ---------------------------------------------------------------------------

const internalFirewallConfigCache$ = state<Record<string, FirewallConfig>>({});

/**
 * Fetch a firewall config by ref name (e.g. "github", "slack").
 * Results are cached in the signal store for the session.
 */
export const fetchFirewallConfigByRef$ = command(
  async ({ get, set }, ref: string): Promise<FirewallConfig> => {
    const cache = get(internalFirewallConfigCache$);
    const cached = cache[ref];
    if (cached) {
      return cached;
    }

    const rawUrl = buildFirewallYamlUrl(ref);
    const res = await fetch(rawUrl);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch firewall config "${ref}": ${res.status}`,
      );
    }

    const content = await res.text();
    const yamlData: unknown = parseYaml(content);
    const result = firewallConfigSchema.safeParse(yamlData);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid firewall config "${ref}": ${issues}`);
    }

    set(internalFirewallConfigCache$, { ...cache, [ref]: result.data });
    return result.data;
  },
);

// ---------------------------------------------------------------------------
// Permission policy: allow | deny | always_allow
// ---------------------------------------------------------------------------

export type PermissionPolicy = "allow" | "deny" | "always_allow";

/**
 * Per-permission policy map keyed by `{agentName}:{firewallRef}`.
 * Each value maps permission name → policy. Missing entries default to "allow".
 */
const internalFirewallPolicies$ = state<
  Record<string, Record<string, PermissionPolicy>>
>({});

function policyKey(agentName: string, ref: string): string {
  return `${agentName}:${ref}`;
}

/** Set the full policy map for a specific agent + firewall ref. */
export const setFirewallPolicies$ = command(
  (
    { get, set },
    agentName: string,
    ref: string,
    policies: Record<string, PermissionPolicy>,
  ) => {
    const current = get(internalFirewallPolicies$);
    set(internalFirewallPolicies$, {
      ...current,
      [policyKey(agentName, ref)]: policies,
    });
  },
);
