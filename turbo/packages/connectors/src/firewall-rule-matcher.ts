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

export interface FindMatchingPermissionsOptions {
  apiBase?: string;
}

interface ApiMatchState {
  bestSpecificity: PathSpecificity | null;
  matched: string[];
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
const ASCII_CONTROL_MAX = 0x20;
const ASCII_DELETE = 0x7f;
const UNICODE_HIGH_SURROGATE_MIN = 0xd800;
const UNICODE_HIGH_SURROGATE_MAX = 0xdbff;
const UNICODE_LOW_SURROGATE_MIN = 0xdc00;
const UNICODE_LOW_SURROGATE_MAX = 0xdfff;

function hasRawWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\r" ||
      char === "\f" ||
      char === "\v"
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafeUrlCodepoint(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (codeUnit < ASCII_CONTROL_MAX || codeUnit === ASCII_DELETE) {
      return true;
    }
    if (
      UNICODE_HIGH_SURROGATE_MIN <= codeUnit &&
      codeUnit <= UNICODE_HIGH_SURROGATE_MAX
    ) {
      const nextCodeUnit = value.charCodeAt(i + 1);
      if (
        !(
          UNICODE_LOW_SURROGATE_MIN <= nextCodeUnit &&
          nextCodeUnit <= UNICODE_LOW_SURROGATE_MAX
        )
      ) {
        return true;
      }
      i += 1;
      continue;
    }
    if (
      UNICODE_LOW_SURROGATE_MIN <= codeUnit &&
      codeUnit <= UNICODE_LOW_SURROGATE_MAX
    ) {
      return true;
    }
  }
  return false;
}

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

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isInvalidGreedyParam(
  patternIndex: number,
  lastPatternIndex: number,
  prefix: string,
  suffix: string,
): boolean {
  return patternIndex !== lastPatternIndex || prefix !== "" || suffix !== "";
}

function pathSpecificity(pattern: string): PathSpecificity | null {
  if (
    !pattern.startsWith("/") ||
    pattern.includes("?") ||
    pattern.includes("#") ||
    pattern.includes("\\") ||
    hasRawWhitespace(pattern) ||
    hasUnsafeUrlCodepoint(pattern)
  ) {
    return null;
  }

  let literalSegments = 0;
  let mixedParamSegments = 0;
  let plainParamSegments = 0;
  let plusGreedySegments = 0;
  let starGreedySegments = 0;
  let literalChars = 0;
  const segments = splitPathSegments(pattern);
  const paramNames = new Set<string>();
  const lastSegmentIndex = segments.length - 1;

  for (let index = 0; index < segments.length; index += 1) {
    const seg = segments[index]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") return null;
    if (parsed.kind === "literal") {
      literalSegments += 1;
      literalChars += codePointLength(parsed.value);
      continue;
    }
    if (paramNames.has(parsed.name)) return null;
    paramNames.add(parsed.name);
    if (
      parsed.greedy !== "" &&
      isInvalidGreedyParam(
        index,
        lastSegmentIndex,
        parsed.prefix,
        parsed.suffix,
      )
    ) {
      return null;
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

function matchingRulePath(rule: string, upperMethod: string): string | null {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx === -1) return null;
  const ruleMethod = rule.slice(0, spaceIdx);
  if (!VALID_RULE_METHODS.has(ruleMethod)) return null;
  if (ruleMethod !== "ANY" && ruleMethod !== upperMethod) return null;
  return rule.slice(spaceIdx + 1);
}

function isValidPermissionName(permissionName: string): boolean {
  return permissionName !== "" && permissionName !== "all";
}

function recordPermissionMatch(
  state: ApiMatchState,
  permission: string,
  specificity: PathSpecificity,
): void {
  if (
    state.bestSpecificity === null ||
    comparePathSpecificity(specificity, state.bestSpecificity) > 0
  ) {
    state.bestSpecificity = specificity;
    state.matched.length = 0;
  }
  if (
    state.bestSpecificity !== null &&
    comparePathSpecificity(specificity, state.bestSpecificity) === 0 &&
    !state.matched.includes(permission)
  ) {
    state.matched.push(permission);
  }
}

function relativePathFromSegments(
  segments: string[],
  consumed: number,
): string {
  const rest = segments.slice(consumed).join("/");
  return rest === "" ? "/" : `/${rest}`;
}

/**
 * Match a runtime host/authority against a firewall base host pattern.
 *
 * Host comparison is case-insensitive and mirrors the runner's right-to-left
 * host matcher. Non-default ports are part of the normalized authority and
 * therefore participate in the final host segment comparison.
 */
export function matchFirewallHost(
  host: string,
  pattern: string,
): Record<string, string> | null {
  const hostSegsOrig = host.split(".");
  const hostSegsLower = hostSegsOrig.map((segment) => {
    return segment.toLowerCase();
  });
  const patternSegs = pattern.split(".").reverse();

  hostSegsOrig.reverse();
  hostSegsLower.reverse();

  const params: Record<string, string> = {};
  let hi = 0;
  const lastPatternIndex = patternSegs.length - 1;

  for (
    let patternIndex = 0;
    patternIndex < patternSegs.length;
    patternIndex++
  ) {
    const seg = patternSegs[patternIndex]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") return null;
    if (parsed.kind === "literal") {
      if (
        hi >= hostSegsLower.length ||
        hostSegsLower[hi] !== parsed.value.toLowerCase()
      ) {
        return null;
      }
      hi += 1;
      continue;
    }

    const { name, prefix, suffix, greedy } = parsed;
    if (greedy === "+") {
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
      if (hi >= hostSegsOrig.length) return null;
      params[name] = hostSegsOrig.slice(hi).reverse().join(".");
      return params;
    }
    if (greedy === "*") {
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
      params[name] = hostSegsOrig.slice(hi).reverse().join(".");
      return params;
    }
    if (hi >= hostSegsOrig.length) return null;
    if (prefix === "" && suffix === "") {
      params[name] = hostSegsLower[hi]!;
    } else {
      const captured = matchMixedSegment(
        hostSegsLower[hi]!,
        prefix.toLowerCase(),
        suffix.toLowerCase(),
      );
      if (captured === null) return null;
      params[name] = captured;
    }
    hi += 1;
  }

  return hi === hostSegsOrig.length ? params : null;
}

/**
 * Match a runtime path against the beginning of a firewall base path pattern.
 *
 * Unlike matchFirewallPath(), this intentionally allows extra runtime path
 * segments and returns the remaining relative path after the base prefix.
 */
export function matchFirewallPathPrefix(
  path: string,
  pattern: string,
): string | null {
  const pathSegs = splitPathSegments(path);
  const patternSegs = splitPathSegments(pattern);

  let pi = 0;
  const lastPatternIndex = patternSegs.length - 1;
  for (
    let patternIndex = 0;
    patternIndex < patternSegs.length;
    patternIndex++
  ) {
    const seg = patternSegs[patternIndex]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") return null;
    if (parsed.kind === "literal") {
      if (pi >= pathSegs.length || pathSegs[pi] !== parsed.value) return null;
      pi += 1;
      continue;
    }

    const { prefix, suffix, greedy } = parsed;
    if (greedy === "+") {
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
      if (pi >= pathSegs.length || !hasNonEmptySegment(pathSegs, pi)) {
        return null;
      }
      return "/";
    }
    if (greedy === "*") {
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
      return "/";
    }
    if (pi >= pathSegs.length) return null;

    const runtime = pathSegs[pi]!;
    if (prefix === "" && suffix === "") {
      if (runtime === "") return null;
    } else if (matchMixedSegment(runtime, prefix, suffix) === null) {
      return null;
    }
    pi += 1;
  }

  return relativePathFromSegments(pathSegs, pi);
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
  const lastPatternIndex = patternSegs.length - 1;

  for (
    let patternIndex = 0;
    patternIndex < patternSegs.length;
    patternIndex++
  ) {
    const seg = patternSegs[patternIndex]!;
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
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
      if (pi >= pathSegs.length || !hasNonEmptySegment(pathSegs, pi)) {
        return null;
      }
      params[name] = pathSegs.slice(pi).join("/");
      return params;
    }
    if (greedy === "*") {
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
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
  options: FindMatchingPermissionsOptions = {},
): string[] {
  const upperMethod = method.toUpperCase();
  const apiBase =
    options.apiBase === undefined ? null : stripTrailingSlash(options.apiBase);
  const matched: string[] = [];

  for (const api of config.apis) {
    if (apiBase !== null && stripTrailingSlash(api.base) !== apiBase) continue;
    if (!api.permissions) continue;
    const state: ApiMatchState = { bestSpecificity: null, matched: [] };
    const seenPermissionNames = new Set<string>();

    for (const perm of api.permissions) {
      if (!isValidPermissionName(perm.name)) continue;
      if (seenPermissionNames.has(perm.name)) continue;
      seenPermissionNames.add(perm.name);
      for (const rule of perm.rules) {
        const rest = matchingRulePath(rule, upperMethod);
        if (rest === null) continue;

        if (matchFirewallPath(path, rest) !== null) {
          const specificity = pathSpecificity(rest);
          if (specificity === null) continue;
          recordPermissionMatch(state, perm.name, specificity);
        }
      }
    }

    for (const permission of state.matched) {
      if (!matched.includes(permission)) {
        matched.push(permission);
      }
    }
  }

  return matched;
}
