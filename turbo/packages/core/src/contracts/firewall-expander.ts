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

const VALID_GRAPHQL_TYPES = new Set(["query", "mutation", "subscription"]);

const GRAPHQL_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\*?$/;

/** Matches GraphQL field patterns: `name`, `name*`, `a.b.c`, `a.b.*` (bare `*` handled before regex). */
const GRAPHQL_FIELD_PATTERN_RE =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*\*?$|^([a-zA-Z_][a-zA-Z0-9_]*\.)+\*$/;

function validateGraphQLModifiers(
  modifiers: string[],
  rule: string,
  permName: string,
  serviceName: string,
): void {
  if (modifiers.length === 0) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": GraphQL keyword requires at least one modifier (type:, operationName:, or field:)`,
    );
  }
  for (const part of modifiers) {
    if (part.startsWith("type:")) {
      const val = part.slice(5);
      if (!VALID_GRAPHQL_TYPES.has(val)) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": GraphQL type must be "query", "mutation", or "subscription", got "${val}"`,
        );
      }
    } else if (part.startsWith("operationName:")) {
      const val = part.slice(14);
      if (!val) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": empty GraphQL operationName`,
        );
      }
      if (val !== "*" && !GRAPHQL_IDENTIFIER_RE.test(val)) {
        throw new Error(
          `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": invalid GraphQL operationName pattern "${val}"`,
        );
      }
    } else if (part.startsWith("field:")) {
      const fields = part.slice(6).split(",");
      for (const val of fields) {
        if (!val) {
          throw new Error(
            `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": empty GraphQL field name`,
          );
        }
        if (val !== "*" && !GRAPHQL_FIELD_PATTERN_RE.test(val)) {
          throw new Error(
            `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": invalid GraphQL field pattern "${val}"`,
          );
        }
      }
    } else {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": unknown GraphQL modifier "${part}"`,
      );
    }
  }
}

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

  // Check for GraphQL suffix: "POST /graphql GraphQL type:query operationName:foo"
  const gqlIdx = rest.indexOf(" GraphQL");
  if (gqlIdx !== -1) {
    const path = rest.slice(0, gqlIdx);
    const suffixStr = rest.slice(gqlIdx + 1); // "GraphQL type:query ..."
    const suffixParts = suffixStr.split(/\s+/);
    // suffixParts[0] is "GraphQL", rest are modifiers
    validatePathSegments(path, rule, permName, serviceName);
    validateGraphQLModifiers(suffixParts.slice(1), rule, permName, serviceName);
  } else {
    validatePathSegments(rest, rule, permName, serviceName);
  }
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
 * Resolve a firewall selections map to expanded configs.
 * Pure function: takes a map of firewall refs → permission selections and returns
 * fully resolved ExpandedFirewallConfig[].
 *
 * Input:  Record<ref, { permissions: string[] | "all" }>
 * Output: ExpandedFirewallConfig[]
 *
 * Validates permission names, filters api_entries to only include selected permissions,
 * and drops entries with no remaining APIs.
 *
 * @param selections - Map of firewall refs to permission selections
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
    entries.map(([ref]) => {
      return fetchFirewallConfig(ref, fetchFn);
    }),
  );

  for (let i = 0; i < entries.length; i++) {
    const [ref, selection] = entries[i]!;
    const serviceConfig = resolvedConfigs[i]!;
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
        return (api.permissions ?? []).length > 0;
      });

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

  return expanded;
}
