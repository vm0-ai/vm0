import { connectorTypeSchema } from "./connectors";
import {
  getFirewallConfig,
  type FirewallConfig,
  type ExpandedFirewallConfig,
} from "./firewall";

export interface FirewallSelection {
  permissions: string[] | "all";
}

const VALID_RULE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ANY",
]);

export function validateRule(
  rule: string,
  permName: string,
  serviceName: string,
): void {
  const parts = rule.split(" ", 2);
  if (parts.length !== 2 || !parts[1]) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": must be "METHOD /path"`,
    );
  }
  const [method, path] = parts as [string, string];
  if (!VALID_RULE_METHODS.has(method)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": unknown method "${method}" (must be uppercase)`,
    );
  }
  if (!path.startsWith("/")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must start with "/"`,
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain query string or fragment`,
    );
  }
  const segments = path.split("/").filter(Boolean);
  const paramNames = new Set<string>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.startsWith("{") && seg.endsWith("}")) {
      const name = seg.slice(1, -1);
      const baseName = name.endsWith("+") ? name.slice(0, -1) : name;
      if (!baseName) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": empty parameter name`,
        );
      }
      if (paramNames.has(baseName)) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": duplicate parameter name "{${baseName}}"`,
        );
      }
      paramNames.add(baseName);
      if (name.endsWith("+") && i !== segments.length - 1) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": {${name}} must be the last segment`,
        );
      }
    }
  }
}

export function validateBaseUrl(base: string, serviceName: string): void {
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
 * Resolve a single firewall ref to its config and validate it exists.
 */
export function resolveFirewallConfig(ref: string): FirewallConfig {
  const parsed = connectorTypeSchema.safeParse(ref);
  if (!parsed.success) {
    throw new Error(
      `Cannot resolve firewall ref "${ref}": no built-in firewall config with this name`,
    );
  }
  const serviceConfig = getFirewallConfig(parsed.data);
  if (!serviceConfig) {
    throw new Error(
      `Firewall ref "${ref}" resolved to "${parsed.data}" but it does not support proxy-side token replacement`,
    );
  }
  return serviceConfig;
}

/**
 * Collect available permission names from a firewall config.
 * Validates uniqueness and that "all" is not used as a permission name.
 */
export function collectAndValidatePermissions(
  ref: string,
  serviceConfig: FirewallConfig,
): Set<string> {
  if (serviceConfig.apis.length === 0) {
    throw new Error(
      `Firewall "${serviceConfig.name}" (ref "${ref}") has no api entries`,
    );
  }
  const available = new Set<string>();
  for (const api of serviceConfig.apis) {
    validateBaseUrl(api.base, serviceConfig.name);
    if (!api.permissions || api.permissions.length === 0) {
      throw new Error(
        `API entry "${api.base}" in firewall "${serviceConfig.name}" (ref "${ref}") has no permissions`,
      );
    }
    // Uniqueness is enforced within a single api_entry. The same permission
    // name across different api_entries is allowed (e.g., "full-access" on
    // both slack.com/api and files.slack.com).
    const seen = new Set<string>();
    for (const perm of api.permissions) {
      if (!perm.name) {
        throw new Error(
          `Firewall "${serviceConfig.name}" (ref "${ref}") has a permission with empty name`,
        );
      }
      if (perm.name === "all") {
        throw new Error(
          `Firewall "${serviceConfig.name}" (ref "${ref}") has a permission named "all", which is a reserved keyword`,
        );
      }
      if (seen.has(perm.name)) {
        throw new Error(
          `Duplicate permission name "${perm.name}" in API entry "${api.base}" of firewall "${serviceConfig.name}" (ref "${ref}")`,
        );
      }
      if (perm.rules.length === 0) {
        throw new Error(
          `Permission "${perm.name}" in firewall "${serviceConfig.name}" (ref "${ref}") has no rules`,
        );
      }
      for (const rule of perm.rules) {
        validateRule(rule, perm.name, serviceConfig.name);
      }
      seen.add(perm.name);
      available.add(perm.name);
    }
  }
  return available;
}

/**
 * Expand experimental_firewall from map format to ExpandedFirewallConfig[] in-place.
 * Validates permission names and filters api_entries to only include selected permissions.
 * Mutates the config object so the API receives pre-expanded firewall objects.
 *
 * Input (from vm0.yaml):  Record<ref, { permissions: string[] | "all" }>
 * Output (for API):       ExpandedFirewallConfig[]
 *
 * The union type in the `as` cast covers both shapes since this function
 * transforms the field from one to the other. Already-expanded arrays are
 * skipped via the Array.isArray guard.
 *
 * TODO: Support resolving firewall configs from GitHub URLs (like skills).
 * Currently only resolves from built-in FIREWALL_CONFIGS via connectorTypeSchema.
 */
export function expandFirewallConfigs(config: unknown): void {
  const compose = config as {
    agents?: Record<
      string,
      {
        experimental_firewall?:
          | Record<string, FirewallSelection>
          | ExpandedFirewallConfig[];
      }
    >;
  };
  if (!compose?.agents) return;

  for (const agent of Object.values(compose.agents)) {
    const configs = agent.experimental_firewall;
    if (!configs) continue;
    // Skip if already expanded (array, not map)
    if (Array.isArray(configs)) continue;

    const expanded: ExpandedFirewallConfig[] = [];

    for (const [ref, selection] of Object.entries(configs)) {
      const serviceConfig = resolveFirewallConfig(ref);
      const availablePermissions = collectAndValidatePermissions(
        ref,
        serviceConfig,
      );

      // Validate selected permissions exist
      if (selection.permissions !== "all") {
        for (const name of selection.permissions) {
          if (!availablePermissions.has(name)) {
            const available = [...availablePermissions].join(", ");
            throw new Error(
              `Permission "${name}" does not exist in firewall "${serviceConfig.name}" (ref "${ref}"). Available: ${available}`,
            );
          }
        }
      }

      // Filter api_entries: keep only selected permissions, drop empty entries
      const selectedSet =
        selection.permissions === "all" ? null : new Set(selection.permissions);

      const filteredApis = serviceConfig.apis
        .map((api) => ({
          ...api,
          permissions: selectedSet
            ? (api.permissions ?? []).filter((p) => selectedSet.has(p.name))
            : api.permissions,
        }))
        .filter((api) => (api.permissions ?? []).length > 0);

      // Drop firewall config entirely if no api_entries remain
      if (filteredApis.length === 0) continue;

      const entry: ExpandedFirewallConfig = {
        name: serviceConfig.name,
        ref,
        apis: filteredApis,
      };
      if (serviceConfig.description !== undefined)
        entry.description = serviceConfig.description;
      if (serviceConfig.placeholders !== undefined)
        entry.placeholders = serviceConfig.placeholders;
      expanded.push(entry);
    }

    agent.experimental_firewall = expanded;
  }
}
