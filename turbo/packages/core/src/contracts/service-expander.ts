import { connectorTypeSchema } from "./connectors";
import {
  getServiceConfig,
  type ServiceConfig,
  type ExpandedServiceConfig,
} from "./services";

export interface ServiceSelection {
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
      `Invalid rule "${rule}" in permission "${permName}" of service "${serviceName}": must be "METHOD /path"`,
    );
  }
  const [method, path] = parts as [string, string];
  if (!VALID_RULE_METHODS.has(method)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of service "${serviceName}": unknown method "${method}" (must be uppercase)`,
    );
  }
  if (!path.startsWith("/")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of service "${serviceName}": path must start with "/"`,
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of service "${serviceName}": path must not contain query string or fragment`,
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
          `Invalid rule "${rule}" in permission "${permName}" of service "${serviceName}": empty parameter name`,
        );
      }
      if (paramNames.has(baseName)) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of service "${serviceName}": duplicate parameter name "{${baseName}}"`,
        );
      }
      paramNames.add(baseName);
      if (name.endsWith("+") && i !== segments.length - 1) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of service "${serviceName}": {${name}} must be the last segment`,
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
      `Invalid base URL "${base}" in service "${serviceName}": not a valid URL`,
    );
  }
  if (url.search) {
    throw new Error(
      `Invalid base URL "${base}" in service "${serviceName}": must not contain query string`,
    );
  }
  if (url.hash) {
    throw new Error(
      `Invalid base URL "${base}" in service "${serviceName}": must not contain fragment`,
    );
  }
}

/**
 * Resolve a single service ref to its config and validate it exists.
 */
export function resolveServiceConfig(ref: string): ServiceConfig {
  const parsed = connectorTypeSchema.safeParse(ref);
  if (!parsed.success) {
    throw new Error(
      `Cannot resolve service ref "${ref}": no built-in service with this name`,
    );
  }
  const serviceConfig = getServiceConfig(parsed.data);
  if (!serviceConfig) {
    throw new Error(
      `Service ref "${ref}" resolved to "${parsed.data}" but it does not support proxy-side token replacement`,
    );
  }
  return serviceConfig;
}

/**
 * Collect available permission names from a service config.
 * Validates uniqueness and that "all" is not used as a permission name.
 */
export function collectAndValidatePermissions(
  ref: string,
  serviceConfig: ServiceConfig,
): Set<string> {
  if (serviceConfig.apis.length === 0) {
    throw new Error(
      `Service "${serviceConfig.name}" (ref "${ref}") has no api entries`,
    );
  }
  const available = new Set<string>();
  for (const api of serviceConfig.apis) {
    validateBaseUrl(api.base, serviceConfig.name);
    if (!api.permissions || api.permissions.length === 0) {
      throw new Error(
        `API entry "${api.base}" in service "${serviceConfig.name}" (ref "${ref}") has no permissions`,
      );
    }
    // Uniqueness is enforced within a single api_entry. The same permission
    // name across different api_entries is allowed (e.g., "full-access" on
    // both slack.com/api and files.slack.com).
    const seen = new Set<string>();
    for (const perm of api.permissions) {
      if (!perm.name) {
        throw new Error(
          `Service "${serviceConfig.name}" (ref "${ref}") has a permission with empty name`,
        );
      }
      if (perm.name === "all") {
        throw new Error(
          `Service "${serviceConfig.name}" (ref "${ref}") has a permission named "all", which is a reserved keyword`,
        );
      }
      if (seen.has(perm.name)) {
        throw new Error(
          `Duplicate permission name "${perm.name}" in API entry "${api.base}" of service "${serviceConfig.name}" (ref "${ref}")`,
        );
      }
      if (perm.rules.length === 0) {
        throw new Error(
          `Permission "${perm.name}" in service "${serviceConfig.name}" (ref "${ref}") has no rules`,
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
 * Expand experimental_services from map format to ExpandedServiceConfig[] in-place.
 * Validates permission names and filters api_entries to only include selected permissions.
 * Mutates the config object so the API receives pre-expanded service objects.
 *
 * Input (from vm0.yaml):  Record<ref, { permissions: string[] | "all" }>
 * Output (for API):       ExpandedServiceConfig[]
 *
 * The union type in the `as` cast covers both shapes since this function
 * transforms the field from one to the other. Already-expanded arrays are
 * skipped via the Array.isArray guard.
 *
 * TODO: Support resolving services from GitHub URLs (like skills).
 * Currently only resolves from built-in SERVICE_CONFIGS via connectorTypeSchema.
 */
export function expandServiceConfigs(config: unknown): void {
  const compose = config as {
    agents?: Record<
      string,
      {
        experimental_services?:
          | Record<string, ServiceSelection>
          | ExpandedServiceConfig[];
      }
    >;
  };
  if (!compose?.agents) return;

  for (const agent of Object.values(compose.agents)) {
    const services = agent.experimental_services;
    if (!services) continue;
    // Skip if already expanded (array, not map)
    if (Array.isArray(services)) continue;

    const expanded: ExpandedServiceConfig[] = [];

    for (const [ref, selection] of Object.entries(services)) {
      const serviceConfig = resolveServiceConfig(ref);
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
              `Permission "${name}" does not exist in service "${serviceConfig.name}" (ref "${ref}"). Available: ${available}`,
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

      // Drop service entirely if no api_entries remain
      if (filteredApis.length === 0) continue;

      const entry: ExpandedServiceConfig = {
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

    agent.experimental_services = expanded;
  }
}
