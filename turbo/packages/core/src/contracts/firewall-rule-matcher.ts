import type { FirewallConfig } from "./firewalls";
import { parseSegment } from "./segment-parser";

/**
 * Match a runtime segment against a mixed pattern's literal prefix/suffix.
 *
 * Byte-exact comparison; callers must case-fold inputs themselves when
 * needed. Returns the captured middle on success, or null if prefix/suffix
 * don't match or the middle would be empty (non-empty guard).
 */
function matchMixedSegment(
  runtime: string,
  prefix: string,
  suffix: string,
): string | null {
  if (!runtime.startsWith(prefix)) return null;
  if (!runtime.endsWith(suffix)) return null;
  if (runtime.length <= prefix.length + suffix.length) return null;
  return runtime.slice(prefix.length, runtime.length - suffix.length);
}

/**
 * Match a URL path against a rule path pattern.
 *
 * Ported from the Python MITM addon's `match_path()` function
 * (crates/runner/mitm-addon/src/matching.py).
 *
 * - Literal segments must match exactly (case-sensitive).
 * - `{name}` matches a single non-empty path segment.
 * - `prefix{name}suffix` (mixed) matches a segment that starts with
 *   `prefix` and ends with `suffix`, with a non-empty middle captured
 *   into `name`.
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
    const parsed = parseSegment(seg);
    // Invalid patterns are rejected by validateRule at ingest time, so
    // kind "error" should never appear here on validated inputs.
    if (parsed.kind === "error") return null;
    if (parsed.kind === "literal") {
      if (pi >= pathSegs.length || pathSegs[pi] !== parsed.value) return null;
      pi++;
      continue;
    }
    const { name, prefix, suffix, greedy } = parsed;
    if (greedy === "+") {
      if (pi >= pathSegs.length) return null;
      params[name] = pathSegs.slice(pi).join("/");
      return params;
    }
    if (greedy === "*") {
      params[name] = pathSegs.slice(pi).join("/");
      return params;
    }
    if (pi >= pathSegs.length) return null;
    const runtime = pathSegs[pi]!;
    if (prefix === "" && suffix === "") {
      params[name] = runtime;
    } else {
      const captured = matchMixedSegment(runtime, prefix, suffix);
      if (captured === null) return null;
      params[name] = captured;
    }
    pi++;
  }

  // All pattern segments consumed; path must also be fully consumed
  if (pi !== pathSegs.length) return null;
  return params;
}

interface GraphQLRule {
  path: string;
  typeFilter: string | null;
  opFilter: string | null;
  fieldFilters: string[] | null;
}

/**
 * Parse the path+suffix portion of a rule for an optional GraphQL qualifier.
 *
 * The `field:` value may be comma-separated for OR semantics
 * (e.g., `field:createIssue,closeIssue`).
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
  let fieldFilters: string[] | null = null;

  for (let i = 1; i < suffixParts.length; i++) {
    const part = suffixParts[i]!;
    if (part.startsWith("type:")) {
      typeFilter = part.slice(5);
    } else if (part.startsWith("operationName:")) {
      opFilter = part.slice(14);
    } else if (part.startsWith("field:")) {
      fieldFilters = part.slice(6).split(",");
    }
  }

  return { path, typeFilter, opFilter, fieldFilters };
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
 * Multiple field filters (from comma-separated `field:a,b,c`) use OR
 * semantics: the body matches if any extracted field matches any pattern.
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
  fieldFilters: string[] | null,
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

  if (fieldFilters !== null) {
    const fields = body.fields;
    if (!fields || fields.length === 0) return false;
    if (
      !fieldFilters.some((pattern) => {
        return fields.some((f) => {
          return matchWildcard(f, pattern);
        });
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
              gql.fieldFilters !== null) &&
            !matchGraphQLBody(
              graphqlBody,
              gql.typeFilter,
              gql.opFilter,
              gql.fieldFilters,
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
