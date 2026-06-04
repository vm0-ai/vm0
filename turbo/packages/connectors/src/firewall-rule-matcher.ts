import {
  type FirewallConfig,
  hasBaseUrlParams,
  validateAuthBaseUrl,
  validateBaseUrl,
} from "./firewall-types";
import { hasRawWhitespace, hasUnsafeUrlCodepoint } from "./firewall-url-utils";
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

export interface FirewallBaseUrlMatch {
  displayBase: string;
  relativePath: string;
  score: number;
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
const FORBIDDEN_RUNTIME_HOST_CHARS = new Set("#%,/<>?@\\^|{}".split(""));
const FORBIDDEN_BASE_PATTERN_HOST_CHARS = new Set("#%,/<>?@\\^|".split(""));
const PERCENT_ESCAPE_LENGTH = 3;
const HEX_DIGITS = new Set("0123456789abcdefABCDEF".split(""));
const PATH_SCORE_MULTIPLIER = 1_000_000;
const AUTHORITY_SCORE_MULTIPLIER = 100;
const LITERAL_SEGMENT_SCORE = 1_000;
const MIXED_PARAM_SEGMENT_SCORE = 100;
const PLAIN_PARAM_SEGMENT_SCORE = 10;
const PLUS_GREEDY_SEGMENT_SCORE = 1;
const ROOT_PATH_SCORE = 1;
const STATIC_BASE_SCORE_BONUS = 1;
const PERCENT_DECODED_AUTHORITY_SYNTAX_CHARS = new Set([
  "{",
  "}",
  ".",
  "\u3002",
  "\uff0e",
  "\uff61",
  ":",
]);

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

function hasUnsafeRuntimeUrlSyntax(value: string): boolean {
  return (
    hasUnsafeUrlCodepoint(value) ||
    hasRawWhitespace(value) ||
    value.includes("\\") ||
    !value.includes("://")
  );
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isObjectRecord(value)) return false;
  return Object.values(value).every((entry) => {
    return typeof entry === "string";
  });
}

function isValidAuthConfig(auth: unknown, serviceName: string): boolean {
  if (!isObjectRecord(auth)) return false;
  if (auth.headers !== undefined && !isStringRecord(auth.headers)) return false;
  if (auth.base !== undefined) {
    if (typeof auth.base !== "string") return false;
    validateAuthBaseUrl(auth.base, serviceName);
  }
  return auth.query === undefined || isStringRecord(auth.query);
}

function isValidApiEntry(
  api: FirewallConfig["apis"][number],
  serviceName: string,
): boolean {
  if (!isObjectRecord(api)) return false;
  if (typeof api.base !== "string") return false;
  try {
    validateBaseUrl(api.base, serviceName);
    if (!isValidAuthConfig(api.auth, serviceName)) return false;
  } catch {
    return false;
  }
  return true;
}

function getPermissionName(permission: unknown): string | null {
  if (!isObjectRecord(permission)) return null;
  if (typeof permission.name !== "string") return null;
  if (!isValidPermissionName(permission.name)) return null;
  return permission.name;
}

function getPermissionRules(permission: unknown): string[] {
  if (!isObjectRecord(permission)) return [];
  if (!Array.isArray(permission.rules)) return [];
  const rules = permission.rules.filter((rule) => {
    return typeof rule === "string";
  });
  return rules;
}

function getApiPermissionsForMatch(
  api: FirewallConfig["apis"][number],
  serviceName: string,
  apiBase: string | null,
): unknown[] | null {
  if (!isValidApiEntry(api, serviceName)) return null;
  if (apiBase !== null && stripTrailingSlash(api.base) !== apiBase) return null;
  if (api.permissions === undefined) return null;
  if (!Array.isArray(api.permissions)) return null;
  return api.permissions;
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

function stripUrlQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (fragmentIndex !== -1) end = Math.min(end, fragmentIndex);
  return url.slice(0, end);
}

function rawPathFromUrl(url: string): string {
  const urlWithoutQuery = stripUrlQueryAndFragment(url);
  const schemeEnd = urlWithoutQuery.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = urlWithoutQuery.indexOf("/", authorityStart);
  return pathStart === -1 ? "/" : urlWithoutQuery.slice(pathStart);
}

function rawBasePathFromUrl(url: string): string {
  const urlWithoutQuery = stripUrlQueryAndFragment(url);
  const schemeEnd = urlWithoutQuery.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = urlWithoutQuery.indexOf("/", authorityStart);
  return pathStart === -1 ? "" : urlWithoutQuery.slice(pathStart);
}

function rawAuthorityFromUrl(url: string): string | null {
  const urlWithoutQuery = stripUrlQueryAndFragment(url);
  const schemeEnd = urlWithoutQuery.indexOf("://");
  if (schemeEnd === -1) return null;
  const authorityStart = schemeEnd + 3;
  const pathStart = urlWithoutQuery.indexOf("/", authorityStart);
  const authority =
    pathStart === -1
      ? urlWithoutQuery.slice(authorityStart)
      : urlWithoutQuery.slice(authorityStart, pathStart);
  return authority === "" ? null : authority;
}

function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}

function rawHostFromAuthority(authority: string): string {
  const withoutUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
  if (withoutUserinfo.startsWith("[")) {
    const closeBracket = withoutUserinfo.indexOf("]");
    return closeBracket === -1
      ? withoutUserinfo
      : withoutUserinfo.slice(0, closeBracket + 1);
  }
  const portSeparator = withoutUserinfo.lastIndexOf(":");
  return portSeparator === -1
    ? withoutUserinfo
    : withoutUserinfo.slice(0, portSeparator);
}

function rawAuthorityHostStartsWithDigit(authority: string): boolean {
  const firstChar = rawHostFromAuthority(authority)[0];
  return firstChar !== undefined && firstChar >= "0" && firstChar <= "9";
}

function runtimeAuthorityOriginForHostValidation(url: string): string | null {
  const authority = rawAuthorityFromUrl(url);
  if (authority === null) return null;
  if (
    !authority.includes("%") &&
    !hasNonAscii(authority) &&
    !rawAuthorityHostStartsWithDigit(authority)
  ) {
    return null;
  }

  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return null;
  return `${url.slice(0, schemeEnd)}://${authority}`;
}

function hasPercentEncodedAuthoritySyntax(value: string): boolean {
  let index = value.indexOf("%");
  while (index !== -1) {
    let runEnd = index;
    while (runEnd < value.length && value[runEnd] === "%") {
      const firstHexDigit = value[runEnd + 1];
      const secondHexDigit = value[runEnd + 2];
      if (
        !firstHexDigit ||
        !secondHexDigit ||
        !HEX_DIGITS.has(firstHexDigit) ||
        !HEX_DIGITS.has(secondHexDigit)
      ) {
        return true;
      }
      runEnd += PERCENT_ESCAPE_LENGTH;
    }

    let decodedRun: string;
    try {
      decodedRun = decodeURIComponent(value.slice(index, runEnd));
    } catch {
      return true;
    }
    for (const char of decodedRun) {
      if (PERCENT_DECODED_AUTHORITY_SYNTAX_CHARS.has(char)) {
        return true;
      }
    }
    index = value.indexOf("%", runEnd);
  }
  return false;
}

function hasMalformedRuntimeAuthoritySyntax(url: string): boolean {
  const authority = rawAuthorityFromUrl(url);
  if (authority === null) return false;
  return (
    authority.includes("\\") || hasPercentEncodedAuthoritySyntax(authority)
  );
}

function scoreLiteralSegment(segment: string): number {
  return LITERAL_SEGMENT_SCORE + codePointLength(segment);
}

function scorePatternSegment(segment: string, allowParams: boolean): number {
  if (!allowParams) return scoreLiteralSegment(segment);

  const parsed = parseSegment(segment);
  if (parsed.kind === "error") return 0;
  if (parsed.kind === "literal") {
    return scoreLiteralSegment(parsed.value);
  }

  const literalChars =
    codePointLength(parsed.prefix) + codePointLength(parsed.suffix);
  if (parsed.prefix !== "" || parsed.suffix !== "") {
    return MIXED_PARAM_SEGMENT_SCORE + literalChars;
  }
  if (parsed.greedy === "+") return PLUS_GREEDY_SEGMENT_SCORE;
  if (parsed.greedy === "*") return 0;
  return PLAIN_PARAM_SEGMENT_SCORE;
}

function scorePatternSegments(
  segments: string[],
  allowParams: boolean,
): number {
  return segments.reduce((score, segment) => {
    return score + scorePatternSegment(segment, allowParams);
  }, 0);
}

function scorePathPattern(path: string, allowParams: boolean): number {
  if (path === "") return 0;
  if (path === "/") return ROOT_PATH_SCORE;
  return scorePatternSegments(splitPathSegments(path), allowParams);
}

function splitAuthoritySegments(authority: string): string[] {
  if (authority.startsWith("[")) return [authority];
  const normalized = authority.endsWith(".")
    ? authority.slice(0, -1)
    : authority;
  return normalized === "" ? [] : normalized.split(".");
}

function baseUrlSpecificityScore(rawBase: string, hasParams: boolean): number {
  const baseForMatch = stripTrailingSlash(rawBase);
  const authorityScore = scorePatternSegments(
    splitAuthoritySegments(rawAuthorityFromUrl(baseForMatch) ?? ""),
    hasParams,
  );
  const pathScore = scorePathPattern(
    rawBasePathFromUrl(baseForMatch),
    hasParams,
  );
  return (
    pathScore * PATH_SCORE_MULTIPLIER +
    authorityScore * AUTHORITY_SCORE_MULTIPLIER +
    (hasParams ? 0 : STATIC_BASE_SCORE_BONUS)
  );
}

function matchStaticBasePathPrefix(
  path: string,
  pattern: string,
): string | null {
  if (pattern === "") {
    return path === "" ? "/" : path;
  }
  if (pattern === "/") {
    if (!path.startsWith(pattern)) return null;
    const relativePath = path.slice(pattern.length);
    if (relativePath !== "" && !relativePath.startsWith("/")) return null;
    return relativePath === "" ? "/" : relativePath;
  }
  if (!path.startsWith(pattern)) return null;
  const relativePath = path.slice(pattern.length);
  if (relativePath !== "" && !relativePath.startsWith("/")) return null;
  return relativePath === "" ? "/" : relativePath;
}

function normalizeUrlHostname(
  hostname: string,
  options: { allowHostParams?: boolean } = {},
): string | null {
  let normalized = hostname.toLowerCase();
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
    if (normalized === "" || normalized.endsWith(".")) {
      return null;
    }
  }
  if (
    normalized.split(".").some((label) => {
      return label === "";
    })
  ) {
    return null;
  }
  const forbiddenChars =
    options.allowHostParams === true
      ? FORBIDDEN_BASE_PATTERN_HOST_CHARS
      : FORBIDDEN_RUNTIME_HOST_CHARS;
  if (
    !normalized.startsWith("[") &&
    [...normalized].some((char) => {
      return forbiddenChars.has(char);
    })
  ) {
    return null;
  }
  return normalized;
}

function normalizedUrlAuthority(
  parsed: URL,
  options: { allowHostParams?: boolean } = {},
): string | null {
  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }

  const hostname = normalizeUrlHostname(parsed.hostname, options);
  if (hostname === null || hostname === "") {
    return null;
  }

  return parsed.port === "" ? hostname : `${hostname}:${parsed.port}`;
}

function matchStaticFirewallBaseUrl(
  url: string,
  rawBase: string,
): FirewallBaseUrlMatch | null {
  const parsedUrl = new URL(url);
  const parsedBase = new URL(rawBase);
  if (parsedUrl.protocol.toLowerCase() !== parsedBase.protocol.toLowerCase()) {
    return null;
  }
  const baseHasParams = hasBaseUrlParams(rawBase);
  const baseForMatch = stripTrailingSlash(rawBase);

  const urlAuthority = normalizedUrlAuthority(parsedUrl);
  const baseAuthority = normalizedUrlAuthority(parsedBase, {
    allowHostParams: baseHasParams,
  });
  if (urlAuthority === null || baseAuthority === null) return null;
  if (baseHasParams) {
    if (matchFirewallHost(urlAuthority, baseAuthority) === null) return null;
  } else if (urlAuthority !== baseAuthority) {
    return null;
  }

  const basePath = rawBasePathFromUrl(baseForMatch);
  const relativePath = baseHasParams
    ? matchFirewallPathPrefix(rawPathFromUrl(url), basePath)
    : matchStaticBasePathPrefix(rawPathFromUrl(url), basePath);
  if (relativePath === null) return null;

  const displayBase = stripTrailingSlash(rawBase);
  return {
    displayBase,
    relativePath,
    score: baseUrlSpecificityScore(rawBase, baseHasParams),
  };
}

export function matchFirewallBaseUrl(
  url: string,
  rawBase: string,
): FirewallBaseUrlMatch | null {
  if (
    hasUnsafeRuntimeUrlSyntax(url) ||
    hasMalformedRuntimeAuthoritySyntax(url)
  ) {
    return null;
  }

  const runtimeAuthorityOrigin = runtimeAuthorityOriginForHostValidation(url);

  try {
    if (runtimeAuthorityOrigin !== null) {
      validateBaseUrl(runtimeAuthorityOrigin, "runtime");
    }
    validateBaseUrl(rawBase, "firewall");
    return matchStaticFirewallBaseUrl(url, rawBase);
  } catch {
    return null;
  }
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
  if (!isObjectRecord(config)) return [];
  if (typeof config.name !== "string" || config.name === "") return [];
  if (!Array.isArray(config.apis)) return [];

  const upperMethod = method.toUpperCase();
  const apiBase =
    options.apiBase === undefined ? null : stripTrailingSlash(options.apiBase);
  const matched: string[] = [];

  for (const api of config.apis) {
    const permissions = getApiPermissionsForMatch(api, config.name, apiBase);
    if (permissions === null) continue;
    const state: ApiMatchState = { bestSpecificity: null, matched: [] };
    const seenPermissionNames = new Set<string>();

    for (const rawPermission of permissions) {
      const permissionName = getPermissionName(rawPermission);
      if (permissionName === null) continue;
      if (seenPermissionNames.has(permissionName)) continue;
      seenPermissionNames.add(permissionName);
      for (const rule of getPermissionRules(rawPermission)) {
        const rest = matchingRulePath(rule, upperMethod);
        if (rest === null) continue;

        if (matchFirewallPath(path, rest) !== null) {
          const specificity = pathSpecificity(rest);
          if (specificity === null) continue;
          recordPermissionMatch(state, permissionName, specificity);
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
