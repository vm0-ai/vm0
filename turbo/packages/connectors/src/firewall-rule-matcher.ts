import type { FirewallConfig } from "./firewall-types";
import { parseSegment, splitPathSegments } from "./segment-parser";

type PathSpecificity = readonly [
  literalSegments: number,
  mixedParamSegments: number,
  plainParamSegments: number,
  plusGreedySegments: number,
  negativeStarGreedySegments: number,
  literalChars: number,
  segmentCount: number,
];

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

function hasNonEmptySegment(segments: string[], start: number): boolean {
  for (let i = start; i < segments.length; i++) {
    if (segments[i] !== "") return true;
  }
  return false;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function pathSpecificity(pattern: string): PathSpecificity | null {
  let literalSegments = 0;
  let mixedParamSegments = 0;
  let plainParamSegments = 0;
  let plusGreedySegments = 0;
  let starGreedySegments = 0;
  let literalChars = 0;
  const segments = splitPathSegments(pattern);

  for (const seg of segments) {
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") return null;
    if (parsed.kind === "literal") {
      literalSegments += 1;
      literalChars += codePointLength(parsed.value);
      continue;
    }

    literalChars +=
      codePointLength(parsed.prefix) + codePointLength(parsed.suffix);
    if (parsed.prefix !== "" || parsed.suffix !== "") {
      mixedParamSegments += 1;
    } else if (parsed.greedy === "+") {
      plusGreedySegments += 1;
    } else if (parsed.greedy === "*") {
      starGreedySegments += 1;
    } else {
      plainParamSegments += 1;
    }
  }

  return [
    literalSegments,
    mixedParamSegments,
    plainParamSegments,
    plusGreedySegments,
    -starGreedySegments,
    literalChars,
    segments.length,
  ];
}

function comparePathSpecificity(
  left: PathSpecificity,
  right: PathSpecificity,
): number {
  for (let i = 0; i < left.length; i++) {
    const difference = left[i]! - right[i]!;
    if (difference !== 0) return difference;
  }
  return 0;
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
  const pathSegs = splitPathSegments(path);
  const patternSegs = splitPathSegments(pattern);

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
      if (pi >= pathSegs.length || !hasNonEmptySegment(pathSegs, pi)) {
        return null;
      }
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
      if (runtime === "") return null;
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
 * Find permission names from a firewall config whose most-specific rules match
 * the given HTTP method and relative path.
 *
 * Method matching is case-insensitive. The special method `ANY` matches
 * any HTTP method. Path specificity mirrors the runner firewall matcher within
 * each API entry.
 */
export function findMatchingPermissions(
  method: string,
  path: string,
  config: FirewallConfig,
): string[] {
  const upperMethod = method.toUpperCase();
  const matched: string[] = [];

  for (const api of config.apis) {
    if (!api.permissions) continue;
    let bestSpecificity: PathSpecificity | null = null;
    const apiMatched: string[] = [];

    for (const perm of api.permissions) {
      for (const rule of perm.rules) {
        const spaceIdx = rule.indexOf(" ");
        if (spaceIdx === -1) continue;
        const ruleMethod = rule.slice(0, spaceIdx).toUpperCase();
        const rest = rule.slice(spaceIdx + 1);
        if (ruleMethod !== "ANY" && ruleMethod !== upperMethod) continue;

        if (matchFirewallPath(path, rest) !== null) {
          const specificity = pathSpecificity(rest);
          if (specificity === null) continue;
          if (
            bestSpecificity === null ||
            comparePathSpecificity(specificity, bestSpecificity) > 0
          ) {
            bestSpecificity = specificity;
            apiMatched.length = 0;
          }
          if (
            bestSpecificity !== null &&
            comparePathSpecificity(specificity, bestSpecificity) === 0 &&
            !apiMatched.includes(perm.name)
          ) {
            apiMatched.push(perm.name);
          }
        }
      }
    }

    for (const permission of apiMatched) {
      if (!matched.includes(permission)) {
        matched.push(permission);
      }
    }
  }

  return matched;
}
