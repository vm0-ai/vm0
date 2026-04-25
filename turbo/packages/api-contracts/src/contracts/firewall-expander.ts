import {
  type FirewallConfig,
  type ExpandedFirewallConfig,
  validateBaseUrl,
} from "./firewalls";
import { parseSegment } from "./segment-parser";
import { fetchFirewallConfig, type FetchFn } from "../firewall-loader";

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

function validatePathSegments(
  path: string,
  rule: string,
  permName: string,
  serviceName: string,
): void {
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
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": ${parsed.reason}`,
      );
    }
    if (parsed.kind === "literal") continue;
    const { name, greedy, prefix, suffix } = parsed;
    if (paramNames.has(name)) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": duplicate parameter name "{${name}}"`,
      );
    }
    paramNames.add(name);
    if (greedy && i !== segments.length - 1) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": {${name}${greedy}} must be the last segment`,
      );
    }
    if (greedy && (prefix !== "" || suffix !== "")) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": greedy parameter {${name}${greedy}} cannot be combined with a literal prefix or suffix in segment "${seg}"`,
      );
    }
  }
}

export function validateRule(
  rule: string,
  permName: string,
  serviceName: string,
): void {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx === -1) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": must be "METHOD /path"`,
    );
  }
  const method = rule.slice(0, spaceIdx);
  const rest = rule.slice(spaceIdx + 1);
  if (!method || !rest) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": must be "METHOD /path"`,
    );
  }
  if (!VALID_RULE_METHODS.has(method)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": unknown method "${method}" (must be uppercase)`,
    );
  }

  validatePathSegments(rest, rule, permName, serviceName);
}

/**
 * Collect available permission names from a firewall config.
 * Validates uniqueness and that "all" is not used as a permission name.
 */
export function collectAndValidatePermissions(
  serviceConfig: FirewallConfig,
): Set<string> {
  if (serviceConfig.apis.length === 0) {
    throw new Error(`Firewall "${serviceConfig.name}" has no api entries`);
  }
  const available = new Set<string>();
  for (const api of serviceConfig.apis) {
    validateBaseUrl(api.base, serviceConfig.name);
    if (!api.permissions || api.permissions.length === 0) {
      // Empty permissions is a valid shape: every request under this base
      // falls through to the firewall's unknownPolicy. Auth headers are
      // still injected on base URL match.
      continue;
    }
    // Uniqueness is enforced within a single api_entry. The same permission
    // name across different api_entries is allowed (e.g., "full-access" on
    // both slack.com/api and files.slack.com).
    const seen = new Set<string>();
    for (const perm of api.permissions) {
      if (!perm.name) {
        throw new Error(
          `Firewall "${serviceConfig.name}" has a permission with empty name`,
        );
      }
      if (perm.name === "all") {
        throw new Error(
          `Firewall "${serviceConfig.name}" has a permission named "all", which is a reserved keyword`,
        );
      }
      if (seen.has(perm.name)) {
        throw new Error(
          `Duplicate permission name "${perm.name}" in API entry "${api.base}" of firewall "${serviceConfig.name}"`,
        );
      }
      if (perm.rules.length === 0) {
        throw new Error(
          `Permission "${perm.name}" in firewall "${serviceConfig.name}" has no rules`,
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
 * Resolve a firewall selections map to expanded configs.
 * Pure function: takes a map of firewall names → permission selections and returns
 * fully resolved ExpandedFirewallConfig[].
 *
 * Input:  Record<name, { permissions: string[] | "all" }>
 * Output: ExpandedFirewallConfig[]
 *
 * Validates permission names, filters api_entries to only include selected permissions,
 * and drops entries with no remaining APIs.
 *
 * @param selections - Map of firewall names to permission selections
 * @param fetchFn - Optional fetch function for HTTP requests (injectable for tests)
 */
export async function resolveFirewallSelections(
  selections: Record<string, FirewallSelection>,
  fetchFn?: FetchFn,
): Promise<ExpandedFirewallConfig[]> {
  const expanded: ExpandedFirewallConfig[] = [];

  // Resolve all firewall configs in parallel
  const entries = Object.entries(selections);
  if (entries.length === 0) return expanded;

  const resolvedConfigs = await Promise.all(
    entries.map(([name]) => {
      return fetchFirewallConfig(name, fetchFn);
    }),
  );

  for (let i = 0; i < entries.length; i++) {
    const [, selection] = entries[i]!;
    const serviceConfig = resolvedConfigs[i]!;
    const availablePermissions = collectAndValidatePermissions(serviceConfig);

    // Validate selected permissions exist
    if (selection.permissions !== "all") {
      for (const name of selection.permissions) {
        if (!availablePermissions.has(name)) {
          const available = [...availablePermissions].join(", ");
          throw new Error(
            `Permission "${name}" does not exist in firewall "${serviceConfig.name}". Available: ${available}`,
          );
        }
      }
    }

    // Filter api_entries: keep only selected permissions, drop empty entries
    const selectedSet =
      selection.permissions === "all" ? null : new Set(selection.permissions);

    const filteredApis = serviceConfig.apis
      .map((api) => {
        return {
          ...api,
          permissions: selectedSet
            ? (api.permissions ?? []).filter((p) => {
                return selectedSet.has(p.name);
              })
            : api.permissions,
        };
      })
      .filter((api) => {
        // When user picked "all", keep every api — including
        // empty-permissions ones where auth-only injection plus
        // unknownPolicy fallback is the intended semantics.
        if (selectedSet === null) return true;
        return (api.permissions ?? []).length > 0;
      });

    // Drop firewall config entirely if no api_entries remain
    if (filteredApis.length === 0) continue;

    const entry: ExpandedFirewallConfig = {
      name: serviceConfig.name,
      apis: filteredApis,
    };
    if (serviceConfig.description !== undefined)
      entry.description = serviceConfig.description;
    if (serviceConfig.placeholders !== undefined)
      entry.placeholders = serviceConfig.placeholders;
    expanded.push(entry);
  }

  return expanded;
}
