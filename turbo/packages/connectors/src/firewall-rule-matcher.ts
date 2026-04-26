import type { FirewallConfig } from "./firewall-types";
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

/**
 * Find all permission names from a firewall config whose rules match
 * the given HTTP method and relative path.
 *
 * Method matching is case-insensitive. The special method `ANY` matches
 * any HTTP method.
 */
export function findMatchingPermissions(
  method: string,
  path: string,
  config: FirewallConfig,
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

        if (matchFirewallPath(path, rest) !== null) {
          matched.add(perm.name);
          break;
        }
      }
    }
  }

  return [...matched];
}
