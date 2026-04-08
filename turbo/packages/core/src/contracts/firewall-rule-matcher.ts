import type { FirewallConfig } from "./firewalls";

/**
 * Parameter segment pattern: `{name}`, `{name+}`, or `{name*}`.
 */
const PARAM_SEG = /^\{([^}]+)\}$/;

/**
 * Match a URL path against a rule path pattern.
 *
 * Ported from the Python MITM addon's `match_path()` function
 * (crates/runner/mitm-addon/src/mitm_addon.py).
 *
 * - Literal segments must match exactly (case-sensitive).
 * - `{name}` matches a single non-empty path segment.
 * - `{name+}` matches the rest of the path (one or more segments). Must be last.
 * - `{name*}` matches the rest of the path (zero or more segments). Must be last.
 *
 * Returns extracted parameters on match, or null on mismatch.
 */
export function matchFirewallPath(
  path: string,
  pattern: string,
): Record<string, string> | null {
  const pathSegs = path.split("/").filter(Boolean);
  const patternSegs = pattern.split("/").filter(Boolean);

  const params: Record<string, string> = {};
  let pi = 0;

  for (const seg of patternSegs) {
    const m = PARAM_SEG.exec(seg);
    if (m) {
      const name = m[1]!;
      if (name.endsWith("+")) {
        // Greedy: consume rest (1+)
        if (pi >= pathSegs.length) return null;
        params[name.slice(0, -1)] = pathSegs.slice(pi).join("/");
        return params;
      }
      if (name.endsWith("*")) {
        // Greedy: consume rest (0+)
        params[name.slice(0, -1)] = pathSegs.slice(pi).join("/");
        return params;
      }
      // Single segment
      if (pi >= pathSegs.length) return null;
      params[name] = pathSegs[pi]!;
      pi++;
    } else {
      // Literal
      if (pi >= pathSegs.length || pathSegs[pi] !== seg) return null;
      pi++;
    }
  }

  // All pattern segments consumed; path must also be fully consumed
  if (pi !== pathSegs.length) return null;
  return params;
}

interface GraphQLRule {
  path: string;
  typeFilter: string | null;
  opFilter: string | null;
  fieldFilter: string | null;
}

/**
 * Parse the path+suffix portion of a rule for an optional GraphQL qualifier.
 *
 * Returns null when the `GraphQL` keyword is absent (plain REST rule).
 */
function parseGraphQLRule(rest: string): GraphQLRule | null {
  const gqlIdx = rest.indexOf(" GraphQL");
  if (gqlIdx === -1) return null;

  const path = gqlIdx > 0 ? rest.slice(0, gqlIdx) : "/";
  const suffixParts = rest.slice(gqlIdx + 1).split(/\s+/); // ["GraphQL", ...]

  let typeFilter: string | null = null;
  let opFilter: string | null = null;
  let fieldFilter: string | null = null;

  for (let i = 1; i < suffixParts.length; i++) {
    const part = suffixParts[i]!;
    if (part.startsWith("type:")) {
      typeFilter = part.slice(5);
    } else if (part.startsWith("operationName:")) {
      opFilter = part.slice(14);
    } else if (part.startsWith("field:")) {
      fieldFilter = part.slice(6);
    }
  }

  return { path, typeFilter, opFilter, fieldFilter };
}

/**
 * Parsed GraphQL request body fields used for matching.
 */
export interface GraphQLBody {
  /** The operation type keyword: `"query"`, `"mutation"`, or `"subscription"`. */
  type: "query" | "mutation" | "subscription";
  /** The named operation, if present. */
  operationName?: string;
  /** Dot-separated field selection paths (e.g., `["createIssue"]`, `["repository.issues"]`). */
  fields?: string[];
}

/**
 * Match a parsed GraphQL body against type, operationName, and field filters.
 *
 * Fail-closed: returns false if required fields are missing.
 */
function matchWildcard(value: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

function matchGraphQLBody(
  body: GraphQLBody | undefined,
  typeFilter: string | null,
  opFilter: string | null,
  fieldFilter: string | null,
): boolean {
  if (!body) return false;

  if (typeFilter !== null && body.type !== typeFilter) {
    return false;
  }

  if (opFilter !== null) {
    const opName = body.operationName;
    if (!opName) return false;
    if (!matchWildcard(opName, opFilter)) return false;
  }

  if (fieldFilter !== null) {
    const fields = body.fields;
    if (!fields || fields.length === 0) return false;
    if (
      !fields.some((f) => {
        return matchWildcard(f, fieldFilter);
      })
    )
      return false;
  }

  return true;
}

/**
 * Find all permission names from a firewall config whose rules match
 * the given HTTP method and relative path.
 *
 * Method matching is case-insensitive. The special method `ANY` matches
 * any HTTP method.
 *
 * When `graphqlBody` is provided, rules containing the `GraphQL` keyword
 * will also match against the parsed body's type, operationName, and fields.
 */
export function findMatchingPermissions(
  method: string,
  path: string,
  config: FirewallConfig,
  graphqlBody?: GraphQLBody,
): string[] {
  const upperMethod = method.toUpperCase();
  const matched = new Set<string>();

  for (const api of config.apis) {
    if (!api.permissions) continue;
    for (const perm of api.permissions) {
      if (matched.has(perm.name)) continue;
      for (const rule of perm.rules) {
        const spaceIdx = rule.indexOf(" ");
        if (spaceIdx === -1) continue;
        const ruleMethod = rule.slice(0, spaceIdx).toUpperCase();
        const rest = rule.slice(spaceIdx + 1);
        if (ruleMethod !== "ANY" && ruleMethod !== upperMethod) continue;

        const gql = parseGraphQLRule(rest);
        const rulePath = gql ? gql.path : rest;

        if (matchFirewallPath(path, rulePath) !== null) {
          if (
            gql &&
            (gql.typeFilter !== null ||
              gql.opFilter !== null ||
              gql.fieldFilter !== null) &&
            !matchGraphQLBody(
              graphqlBody,
              gql.typeFilter,
              gql.opFilter,
              gql.fieldFilter,
            )
          ) {
            continue;
          }
          matched.add(perm.name);
          break;
        }
      }
    }
  }

  return [...matched];
}
