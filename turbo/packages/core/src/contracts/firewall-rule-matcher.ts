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
        const rulePath = rule.slice(spaceIdx + 1);
        if (ruleMethod !== "ANY" && ruleMethod !== upperMethod) continue;
        if (matchFirewallPath(path, rulePath) !== null) {
          matched.add(perm.name);
          break;
        }
      }
    }
  }

  return [...matched];
}
