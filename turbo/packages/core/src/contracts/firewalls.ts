import { z } from "zod";

/**
 * Proxy-side firewall configuration for token replacement.
 *
 * All firewall zod schemas are defined here as the single source of truth.
 * Other modules (composes.ts, runners.ts) import from here.
 *
 * Firewall configs are hosted in GitHub: vm0-ai/vm0-firewalls
 * See resolveFirewallSelections() in firewall-expander.ts for resolution logic.
 */

/**
 * Firewall permission schema — a named permission group with matching rules.
 * Rules use the format `METHOD /path` where path is relative to the API entry's base URL.
 */
export const firewallPermissionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  rules: z.array(z.string()),
});

/**
 * Firewall API entry — a base URL with auth headers and optional permissions.
 */
export const firewallApiSchema = z.object({
  base: z.string(),
  auth: z.object({
    headers: z.record(z.string(), z.string()),
  }),
  permissions: z.array(firewallPermissionSchema).optional(),
});

/**
 * A single firewall with its name, ref, and API entries.
 * Used in the expanded (post-compose) format.
 */
export const firewallSchema = z.object({
  name: z.string(),
  ref: z.string(),
  apis: z.array(firewallApiSchema),
});

/**
 * Experimental firewall configuration for proxy-side token replacement.
 * Flat array of firewall entries: [{ name, ref, apis }]
 */
export const experimentalFirewallsSchema = z.array(firewallSchema);

/**
 * Zod schema for validating firewall config (GitHub-hosted YAML).
 */
export const firewallConfigSchema = z.object({
  name: z.string().min(1, "Firewall name is required"),
  description: z.string().optional(),
  apis: z
    .array(firewallApiSchema)
    .min(1, "Firewall must have at least one API entry"),
  placeholders: z.record(z.string(), z.string()).optional(),
});

/**
 * Firewall policy value — per-permission access control.
 * - "allow": always allow without prompting
 * - "deny": always deny
 * - "ask": prompt user for approval each time
 */
export const firewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);
export type FirewallPolicyValue = z.infer<typeof firewallPolicyValueSchema>;

/**
 * Firewall policies — nested map of firewall ref → permission name → policy.
 * Example: { "github": { "repo-read": "allow", "issues-write": "deny" } }
 */
export const firewallPoliciesSchema = z.record(
  z.string(),
  z.record(z.string(), firewallPolicyValueSchema),
);
export type FirewallPolicies = z.infer<typeof firewallPoliciesSchema>;

/** Inferred types */
export type FirewallApi = z.infer<typeof firewallApiSchema>;
export type FirewallConfig = z.infer<typeof firewallConfigSchema>;
export type Firewall = z.infer<typeof firewallSchema>;
export type ExperimentalFirewalls = z.infer<typeof experimentalFirewallsSchema>;

/**
 * Regex pattern matching `${{ secrets.XXX }}` references in auth header templates.
 * Tolerates optional whitespace inside braces: `${{ secrets.X }}` and `${{secrets.X}}`.
 */
const AUTH_SECRET_PATTERN =
  /\$\{\{\s*secrets\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Extract all secret names referenced in firewall rule auth header templates.
 * E.g., `Bearer ${{ secrets.GITHUB_TOKEN }}` → `["GITHUB_TOKEN"]`
 */
export function extractSecretNamesFromApis(
  apis: FirewallConfig["apis"],
): string[] {
  const names = new Set<string>();
  for (const entry of apis) {
    for (const value of Object.values(entry.auth.headers)) {
      for (const match of value.matchAll(AUTH_SECRET_PATTERN)) {
        names.add(match[1]!);
      }
    }
  }
  return [...names];
}

/**
 * Regex pattern matching `${{ vars.XXX }}` references in base URL templates.
 */
const BASE_URL_VARS_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/;
const BASE_URL_VARS_PATTERN_G = new RegExp(BASE_URL_VARS_PATTERN.source, "g");

/**
 * Check if a base URL contains `${{ vars.X }}` template references.
 */
export function hasBaseUrlVars(base: string): boolean {
  return BASE_URL_VARS_PATTERN.test(base);
}

/**
 * Resolve `${{ vars.X }}` templates in firewall base URLs.
 * Returns a new array with all base URL templates replaced by actual values.
 * Throws if a referenced variable is not provided.
 */
export function resolveFirewallBaseUrlVars(
  firewalls: ExperimentalFirewalls,
  vars: Record<string, string> | undefined,
): ExperimentalFirewalls {
  return firewalls.map((fw) => ({
    ...fw,
    apis: fw.apis.map((api) => {
      if (!hasBaseUrlVars(api.base)) return api;
      const resolved = api.base.replace(
        BASE_URL_VARS_PATTERN_G,
        (_match, name: string) => {
          const value = vars?.[name];
          if (!value) {
            throw new Error(
              `Firewall "${fw.name}" base URL requires variable "${name}" but it was not provided`,
            );
          }
          return value;
        },
      );
      validateBaseUrl(resolved, fw.name);
      return { ...api, base: resolved };
    }),
  }));
}

export function validateBaseUrl(base: string, serviceName: string): void {
  // Template base URLs are validated after variable resolution at compose time.
  if (hasBaseUrlVars(base)) return;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": not a valid URL`,
    );
  }
  if (url.search) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain query string`,
    );
  }
  if (url.hash) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain fragment`,
    );
  }
}

/**
 * Expanded firewall config stored in compose content.
 * Resolved from firewall name + FirewallConfig at compose time, then frozen.
 *
 * - `name`: firewall config name (e.g., "slack")
 * - `ref`: key used in vm0.yaml to reference this firewall config
 * - `description`: optional description from the firewall config
 */
export interface ExpandedFirewallConfig {
  name: string;
  ref: string;
  description?: string;
  apis: FirewallApi[];
  placeholders?: Record<string, string>;
}
