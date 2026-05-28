import { z } from "zod";

import { parseSegment } from "./segment-parser";

/**
 * Proxy-side firewall configuration for token replacement.
 *
 * All firewall zod schemas are defined here as the single source of truth.
 * Other modules (composes.ts, runners.ts) import from here.
 *
 * Firewall configs are hosted in GitHub: vm0-ai/vm0-firewalls
 * See resolveFirewallSelections() in firewall-expander.ts for resolution logic.
 */

/**
 * Firewall permission schema — a named permission group with matching rules.
 * Rules use the format `METHOD /path` where path is relative to the API entry's base URL.
 */
export const firewallPermissionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  rules: z.array(z.string()),
});

/**
 * Firewall API entry — a base URL with optional auth headers/query/base and permissions.
 */
export const firewallApiSchema = z.object({
  base: z.string(),
  auth: z.object({
    headers: z.record(z.string(), z.string()).optional(),
    base: z.string().optional(),
    query: z.record(z.string(), z.string()).optional(),
  }),
  permissions: z.array(firewallPermissionSchema).optional(),
});

/**
 * A single firewall with its name and API entries.
 * Used in the expanded (post-compose) format.
 */
export const firewallSchema = z.object({
  name: z.string(),
  apis: z.array(firewallApiSchema),
});

/**
 * Firewall configuration for proxy-side token replacement.
 * Flat array of firewall entries: [{ name, apis }]
 */
export const firewallsSchema = z.array(firewallSchema);

/**
 * Zod schema for validating firewall config (GitHub-hosted YAML).
 */
export const firewallConfigSchema = z.object({
  name: z.string().min(1, "Firewall name is required"),
  description: z.string().optional(),
  apis: z
    .array(firewallApiSchema)
    .min(1, "Firewall must have at least one API entry"),
  placeholders: z.record(z.string(), z.string()).optional(),
});

/**
 * Firewall policy value — per-permission access control.
 * - "allow": always allow without prompting
 * - "deny": always deny
 * - "ask": prompt user for approval each time
 */
export const firewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);
export type FirewallPolicyValue = z.infer<typeof firewallPolicyValueSchema>;

/**
 * Per-connector policy: permission map + unknown endpoint handling.
 */
export const firewallPolicySchema = z.object({
  policies: z.record(z.string(), firewallPolicyValueSchema),
  unknownPolicy: firewallPolicyValueSchema.optional(),
});
export type FirewallPolicy = z.infer<typeof firewallPolicySchema>;

/**
 * Firewall policies — map of firewall name → connector policy.
 * Example: { "github": { policies: { "repo-read": "allow" }, unknownPolicy: "allow" } }
 */
export const firewallPoliciesSchema = z.record(
  z.string(),
  firewallPolicySchema,
);
export type FirewallPolicies = z.infer<typeof firewallPoliciesSchema>;

/**
 * Raw DB format for permission_policies column (flat permission map).
 * Used only for DB column type annotations — application code uses FirewallPolicies.
 */
export type RawPermissionPolicies = Record<
  string,
  Record<string, FirewallPolicyValue>
>;

/**
 * Merge two DB columns into a unified FirewallPolicies object.
 * Call at DB read boundaries.
 */
export function toFirewallPolicies(
  raw: RawPermissionPolicies | null | undefined,
  unknownPermissionPolicies:
    | Record<string, FirewallPolicyValue>
    | null
    | undefined,
): FirewallPolicies | null {
  if (!raw && !unknownPermissionPolicies) return null;
  const result: FirewallPolicies = {};
  const allRefs = new Set([
    ...Object.keys(raw ?? {}),
    ...Object.keys(unknownPermissionPolicies ?? {}),
  ]);
  for (const ref of allRefs) {
    result[ref] = {
      policies: raw?.[ref] ?? {},
      ...(unknownPermissionPolicies?.[ref] !== undefined && {
        unknownPolicy: unknownPermissionPolicies[ref],
      }),
    };
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Split a unified FirewallPolicies back into two DB column values.
 * Call at DB write boundaries.
 */
export function fromFirewallPolicies(policies: FirewallPolicies): {
  permissionPolicies: RawPermissionPolicies;
  unknownPermissionPolicies: Record<string, FirewallPolicyValue>;
} {
  const permissionPolicies: RawPermissionPolicies = {};
  const unknownPermissionPolicies: Record<string, FirewallPolicyValue> = {};
  for (const [ref, config] of Object.entries(policies)) {
    permissionPolicies[ref] = config.policies;
    if (config.unknownPolicy !== undefined) {
      unknownPermissionPolicies[ref] = config.unknownPolicy;
    }
  }
  return { permissionPolicies, unknownPermissionPolicies };
}

/**
 * Per-firewall grant configuration — which permissions are granted and
 * what policy applies to unknown endpoints (not matching any permission rule).
 * Refs absent from the map are fully permissive (all granted + allow unknown).
 */
const networkPolicySchema = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
  ask: z.array(z.string()),
  unknownPolicy: firewallPolicyValueSchema,
});

/**
 * Network policies map — firewall name → policy config.
 * Example: { "github": { allow: ["repo-read"], deny: ["admin"], ask: [], unknownPolicy: "deny" } }
 */
export const networkPoliciesSchema = z.record(z.string(), networkPolicySchema);
export type NetworkPolicies = z.infer<typeof networkPoliciesSchema>;

/** Inferred types */
export type FirewallApi = z.infer<typeof firewallApiSchema>;
export type FirewallConfig = z.infer<typeof firewallConfigSchema>;
export type Firewall = z.infer<typeof firewallSchema>;
export type Firewalls = z.infer<typeof firewallsSchema>;

/**
 * Regex pattern matching `${{ secrets.XXX }}` references in auth header templates.
 * Tolerates optional whitespace inside braces: `${{ secrets.X }}` and `${{secrets.X}}`.
 */
const AUTH_SECRET_PATTERN =
  /\$\{\{\s*secrets\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const AUTH_REFERENCE_PATTERN =
  /\$\{\{\s*(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export type FirewallTemplateReferenceNamespace = "secrets" | "vars";

export interface FirewallTemplateReferences {
  readonly secrets: readonly string[];
  readonly vars: readonly string[];
}

export interface BasicAuthTemplateArg {
  readonly namespace?: FirewallTemplateReferenceNamespace;
  readonly key?: string;
  readonly literal?: string;
}

export interface BasicAuthTemplateMatch {
  readonly start: number;
  readonly end: number;
  readonly first: BasicAuthTemplateArg;
  readonly second: BasicAuthTemplateArg;
}

interface ParsedBasicArg {
  readonly arg: BasicAuthTemplateArg | null;
  readonly index: number;
}

interface ParsedBasicTemplate {
  readonly match: BasicAuthTemplateMatch | null;
  readonly index: number;
}

interface BasicAuthTemplateParserContext {
  readonly nextQuoteIndexes: Int32Array;
  readonly nextBackslashIndexes: Int32Array;
  readonly nextTemplateIndexes: Int32Array;
}

function isTemplateWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f" ||
    char === "\v"
  );
}

function skipTemplateWhitespace(template: string, index: number): number {
  let nextIndex = index;
  while (
    nextIndex < template.length &&
    isTemplateWhitespace(template[nextIndex]!)
  ) {
    nextIndex += 1;
  }
  return nextIndex;
}

function isIdentifierStart(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  );
}

function isIdentifierPart(char: string): boolean {
  const code = char.charCodeAt(0);
  return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function parseTemplateIdentifier(
  template: string,
  index: number,
): { readonly value: string; readonly index: number } | null {
  if (index >= template.length || !isIdentifierStart(template[index]!)) {
    return null;
  }

  let nextIndex = index + 1;
  while (
    nextIndex < template.length &&
    isIdentifierPart(template[nextIndex]!)
  ) {
    nextIndex += 1;
  }
  return {
    value: template.slice(index, nextIndex),
    index: nextIndex,
  };
}

function createBasicAuthTemplateParserContext(
  template: string,
): BasicAuthTemplateParserContext {
  const nextQuoteIndexes = new Int32Array(template.length + 1);
  const nextBackslashIndexes = new Int32Array(template.length + 1);
  const nextTemplateIndexes = new Int32Array(template.length + 1);
  let nextQuoteIndex = -1;
  let nextBackslashIndex = -1;
  let nextTemplateIndex = -1;
  nextQuoteIndexes[template.length] = nextQuoteIndex;
  nextBackslashIndexes[template.length] = nextBackslashIndex;
  nextTemplateIndexes[template.length] = nextTemplateIndex;

  for (let index = template.length - 1; index >= 0; index -= 1) {
    if (template[index] === '"') {
      nextQuoteIndex = index;
    }
    if (template[index] === "\\") {
      nextBackslashIndex = index;
    }
    if (template.startsWith("${{", index)) {
      nextTemplateIndex = index;
    }
    nextQuoteIndexes[index] = nextQuoteIndex;
    nextBackslashIndexes[index] = nextBackslashIndex;
    nextTemplateIndexes[index] = nextTemplateIndex;
  }

  return { nextQuoteIndexes, nextBackslashIndexes, nextTemplateIndexes };
}

function parseBasicAuthTemplateArg(
  context: BasicAuthTemplateParserContext,
  template: string,
  index: number,
): ParsedBasicArg {
  let nextIndex = skipTemplateWhitespace(template, index);
  const char = template[nextIndex];
  if (char === "," || char === ")") {
    return { arg: {}, index: nextIndex };
  }

  if (char === '"') {
    const literalStart = nextIndex + 1;
    const quoteIndex = context.nextQuoteIndexes[literalStart] ?? -1;
    if (quoteIndex === -1) {
      const nestedTemplateStart =
        context.nextTemplateIndexes[literalStart] ?? -1;
      return {
        arg: null,
        index:
          nestedTemplateStart === -1 ? template.length : nestedTemplateStart,
      };
    }
    const escapeIndex = context.nextBackslashIndexes[literalStart] ?? -1;
    if (escapeIndex !== -1 && escapeIndex < quoteIndex) {
      const nestedTemplateStart =
        context.nextTemplateIndexes[literalStart] ?? -1;
      return {
        arg: null,
        index:
          nestedTemplateStart !== -1 && nestedTemplateStart < escapeIndex
            ? nestedTemplateStart
            : escapeIndex + 1,
      };
    }
    return {
      arg: { literal: template.slice(literalStart, quoteIndex) },
      index: quoteIndex + 1,
    };
  }

  let namespace: FirewallTemplateReferenceNamespace;
  if (template.startsWith("secrets.", nextIndex)) {
    namespace = "secrets";
    nextIndex += "secrets.".length;
  } else if (template.startsWith("vars.", nextIndex)) {
    namespace = "vars";
    nextIndex += "vars.".length;
  } else {
    return { arg: null, index: nextIndex };
  }

  const key = parseTemplateIdentifier(template, nextIndex);
  if (!key) {
    return { arg: null, index: nextIndex };
  }
  return {
    arg: { namespace, key: key.value },
    index: key.index,
  };
}

function parseBasicAuthTemplateAt(
  context: BasicAuthTemplateParserContext,
  template: string,
  start: number,
): ParsedBasicTemplate {
  let index = start + "${{".length;
  index = skipTemplateWhitespace(template, index);
  if (!template.startsWith("basic(", index)) {
    return { match: null, index: start + "${{".length };
  }
  index += "basic(".length;

  const first = parseBasicAuthTemplateArg(context, template, index);
  if (!first.arg) {
    return { match: null, index: first.index };
  }
  index = skipTemplateWhitespace(template, first.index);
  if (template[index] !== ",") {
    return { match: null, index: Math.max(index + 1, first.index) };
  }
  index += 1;

  const second = parseBasicAuthTemplateArg(context, template, index);
  if (!second.arg) {
    return { match: null, index: second.index };
  }
  index = skipTemplateWhitespace(template, second.index);
  if (template[index] !== ")") {
    return { match: null, index: Math.max(index + 1, second.index) };
  }
  index += 1;
  index = skipTemplateWhitespace(template, index);
  if (!template.startsWith("}}", index)) {
    return { match: null, index: Math.max(index + 1, second.index) };
  }

  const end = index + "}}".length;
  return {
    match: {
      start,
      end,
      first: first.arg,
      second: second.arg,
    },
    index: end,
  };
}

function findNextBasicAuthTemplateStart(
  template: string,
  index: number,
): number {
  let basicIndex = template.indexOf("basic(", index);
  while (basicIndex !== -1) {
    let contentStart = basicIndex;
    while (
      contentStart > index &&
      isTemplateWhitespace(template[contentStart - 1]!)
    ) {
      contentStart -= 1;
    }

    const start = contentStart - "${{".length;
    if (start >= index && template.startsWith("${{", start)) {
      return start;
    }

    basicIndex = template.indexOf("basic(", basicIndex + "basic(".length);
  }
  return -1;
}

/**
 * Parse `${{ basic(username, password) }}` templates in linear time.
 * Each side is secrets.X, vars.X, "literal", or empty; comma is required.
 * Literal strings forbid `"` and `\`, and are not subject to simple template
 * resolution.
 */
export function parseBasicAuthTemplates(
  template: string,
): readonly BasicAuthTemplateMatch[] {
  const matches: BasicAuthTemplateMatch[] = [];
  let start = findNextBasicAuthTemplateStart(template, 0);
  if (start === -1) {
    return matches;
  }

  const context = createBasicAuthTemplateParserContext(template);

  while (start !== -1) {
    const parsed = parseBasicAuthTemplateAt(context, template, start);
    if (parsed.match) {
      matches.push(parsed.match);
      start = findNextBasicAuthTemplateStart(template, parsed.index);
    } else {
      start = findNextBasicAuthTemplateStart(
        template,
        Math.max(parsed.index, start + "${{".length),
      );
    }
  }

  return matches;
}

export function replaceBasicAuthTemplates(
  template: string,
  replacer: (match: BasicAuthTemplateMatch) => string,
): string {
  const matches = parseBasicAuthTemplates(template);
  if (matches.length === 0) {
    return template;
  }

  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    parts.push(template.slice(lastIndex, match.start), replacer(match));
    lastIndex = match.end;
  }
  parts.push(template.slice(lastIndex));
  return parts.join("");
}

function forEachSimpleAuthReference(
  template: string,
  basicMatches: readonly BasicAuthTemplateMatch[],
  callback: (namespace: string, name: string) => void,
): void {
  let basicMatchIndex = 0;

  for (const match of template.matchAll(AUTH_REFERENCE_PATTERN)) {
    if (!match[1] || !match[2] || match.index === undefined) {
      continue;
    }

    while (
      basicMatchIndex < basicMatches.length &&
      basicMatches[basicMatchIndex]!.end <= match.index
    ) {
      basicMatchIndex += 1;
    }

    const basicMatch = basicMatches[basicMatchIndex];
    if (
      basicMatch &&
      match.index >= basicMatch.start &&
      match.index < basicMatch.end
    ) {
      continue;
    }

    callback(match[1], match[2]);
  }
}

/**
 * Extract all secret names referenced in firewall rule auth header templates.
 * Handles both simple `${{ secrets.X }}` and `${{ basic(...) }}` templates.
 * E.g., `Bearer ${{ secrets.GITHUB_TOKEN }}` → `["GITHUB_TOKEN"]`
 */
export function extractSecretNamesFromApis(
  apis: FirewallConfig["apis"],
): string[] {
  const names = new Set<string>();
  for (const entry of apis) {
    for (const value of Object.values(entry.auth.headers ?? {})) {
      const basicMatches = parseBasicAuthTemplates(value);
      forEachSimpleAuthReference(value, basicMatches, (namespace, name) => {
        if (namespace === "secrets") {
          names.add(name);
        }
      });
      // basic() args may reference secrets, vars, or be string literals;
      // only collect secrets here (vars don't need placeholders, literals
      // are baked into the config).
      for (const match of basicMatches) {
        if (match.first.namespace === "secrets" && match.first.key) {
          names.add(match.first.key);
        }
        if (match.second.namespace === "secrets" && match.second.key) {
          names.add(match.second.key);
        }
      }
    }
    // Scan auth.base for secret references (webhook-url connectors).
    // Only simple ${{ secrets.X }} — basic() makes no sense in a URL template.
    if (entry.auth.base) {
      for (const match of entry.auth.base.matchAll(AUTH_SECRET_PATTERN)) {
        names.add(match[1]!);
      }
    }
    // Scan auth.query for secret references (query-param auth connectors).
    // Only simple ${{ secrets.X }} — basic() makes no sense in query params.
    if (entry.auth.query) {
      for (const value of Object.values(entry.auth.query)) {
        for (const match of value.matchAll(AUTH_SECRET_PATTERN)) {
          names.add(match[1]!);
        }
      }
    }
  }
  return [...names];
}

function collectFirewallTemplateReferencesFromValue(
  template: string,
  references: { secrets: Set<string>; vars: Set<string> },
): void {
  const basicMatches = parseBasicAuthTemplates(template);
  const addReference = (namespace: string, name: string): void => {
    if (namespace === "secrets") {
      references.secrets.add(name);
    } else if (namespace === "vars") {
      references.vars.add(name);
    }
  };

  forEachSimpleAuthReference(template, basicMatches, addReference);
  for (const match of basicMatches) {
    if (match.first.namespace && match.first.key) {
      addReference(match.first.namespace, match.first.key);
    }
    if (match.second.namespace && match.second.key) {
      addReference(match.second.namespace, match.second.key);
    }
  }
}

export function extractFirewallTemplateReferences(
  apis: FirewallConfig["apis"],
): FirewallTemplateReferences {
  const references = {
    secrets: new Set<string>(),
    vars: new Set<string>(),
  };

  for (const entry of apis) {
    for (const value of Object.values(entry.auth.headers ?? {})) {
      collectFirewallTemplateReferencesFromValue(value, references);
    }
    if (entry.auth.base) {
      collectFirewallTemplateReferencesFromValue(entry.auth.base, references);
    }
    for (const value of Object.values(entry.auth.query ?? {})) {
      collectFirewallTemplateReferencesFromValue(value, references);
    }
  }

  return {
    secrets: [...references.secrets],
    vars: [...references.vars],
  };
}

/**
 * Regex pattern matching `${{ vars.XXX }}` references in base URL templates.
 */
const BASE_URL_VARS_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/;
const BASE_URL_VARS_PATTERN_G = new RegExp(BASE_URL_VARS_PATTERN.source, "g");

/**
 * Check if a base URL contains `${{ vars.X }}` template references.
 */
export function hasBaseUrlVars(base: string): boolean {
  return BASE_URL_VARS_PATTERN.test(base);
}

/**
 * Resolve `${{ vars.X }}` templates in firewall base URLs.
 * Returns a new array with all base URL templates replaced by actual values.
 * Throws if a referenced variable is not provided.
 */
export function resolveFirewallBaseUrlVars(
  firewalls: Firewalls,
  vars: Record<string, string> | undefined,
): Firewalls {
  return firewalls.map((fw) => {
    return {
      ...fw,
      apis: fw.apis.map((api) => {
        if (!hasBaseUrlVars(api.base)) return api;
        const resolved = api.base.replace(
          BASE_URL_VARS_PATTERN_G,
          (_match, name: string) => {
            const value = vars?.[name];
            if (!value) {
              throw new Error(
                `Firewall "${fw.name}" base URL requires variable "${name}" but it was not provided`,
              );
            }
            return value;
          },
        );
        validateBaseUrl(resolved, fw.name);
        return { ...api, base: resolved };
      }),
    };
  });
}

/**
 * Check if a base URL contains `{name}` style parameter placeholders
 * (as opposed to `${{ vars.X }}` template references).
 */
export function hasBaseUrlParams(base: string): boolean {
  // Strip ${{ ... }} template references, then check for remaining { }.
  // Uses string iteration instead of regex to avoid ReDoS risk.
  let stripped = base;
  let start = stripped.indexOf("${{");
  while (start !== -1) {
    const end = stripped.indexOf("}}", start + 3);
    if (end === -1) break;
    stripped = stripped.slice(0, start) + stripped.slice(end + 2);
    start = stripped.indexOf("${{");
  }
  return stripped.includes("{") && stripped.includes("}");
}

const HOST_WILDCARD_PARAM_PREFIX = "hostWildcard";

/**
 * Convert user-facing `*` wildcards in a URL host into the existing
 * parameterized host grammar understood by the firewall matcher.
 *
 * Examples:
 *   - https://*.example.com/ -> https://{hostWildcard1}.example.com/
 *   - https://api-*.example.com/ -> https://api-{hostWildcard1}.example.com/
 *   - https://*.*.example.com/ -> https://{hostWildcard1}.{hostWildcard2}.example.com/
 *
 * Each `*` is a single host-label wildcard. Only the host is transformed.
 * Path `*` characters remain literal.
 */
export function expandHostWildcardsInBaseUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }

  if (!url.hostname.includes("*")) {
    return base;
  }

  let paramIndex = 0;
  const host = url.hostname
    .split(".")
    .map((segment) => {
      if (!segment.includes("*")) {
        return segment;
      }
      let expanded = "";
      for (let i = 0; i < segment.length; i++) {
        const ch = segment[i]!;
        if (ch === "*") {
          paramIndex += 1;
          expanded += `{${HOST_WILDCARD_PARAM_PREFIX}${paramIndex}}`;
        } else {
          expanded += ch;
        }
      }
      return expanded;
    })
    .join(".");

  const authority = url.port ? `${host}:${url.port}` : host;
  return `${url.protocol}//${authority}${url.pathname}${url.search}${url.hash}`;
}

function errMsg(base: string, svc: string, detail: string): string {
  return `Invalid base URL "${base}" in firewall "${svc}": ${detail}`;
}

/**
 * Validate host segments (`.`-delimited) for parameterized base URLs.
 * Greedy params (`+`/`*`) must be the first (leftmost) host segment and
 * must not appear in mixed segments (prefix/suffix).
 * At least one pure-literal segment is required for security — a mixed
 * segment carrying a parameter is NOT counted as static.
 */
function validateHostParams(
  segments: string[],
  paramNames: Set<string>,
  base: string,
  svc: string,
): void {
  if (segments.length < 2) {
    throw new Error(errMsg(base, svc, "host must have at least two segments"));
  }
  let hasStatic = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") {
      throw new Error(errMsg(base, svc, parsed.reason));
    }
    if (parsed.kind === "literal") {
      hasStatic = true;
      continue;
    }
    const { name, greedy, prefix, suffix } = parsed;
    if (paramNames.has(name)) {
      throw new Error(
        errMsg(base, svc, `duplicate parameter name "{${name}}" in host`),
      );
    }
    paramNames.add(name);
    if (greedy && i !== 0) {
      throw new Error(
        errMsg(base, svc, `{${name}${greedy}} must be the first host segment`),
      );
    }
    if (greedy && (prefix !== "" || suffix !== "")) {
      throw new Error(
        errMsg(
          base,
          svc,
          `greedy parameter {${name}${greedy}} cannot be combined with a literal prefix or suffix in host segment "${seg}"`,
        ),
      );
    }
  }
  if (!hasStatic) {
    throw new Error(
      errMsg(base, svc, "host must have at least one static segment"),
    );
  }
}

/**
 * Validate path segments (`/`-delimited) for parameterized base URLs.
 * Greedy params (`+`/`*`) are rejected — they would consume the entire
 * remaining path, leaving nothing for permission rules to match against.
 * Mixed segments (`{param}.ext`, `prefix-{param}`) are accepted.
 */
function validatePathParams(
  segments: string[],
  paramNames: Set<string>,
  base: string,
  svc: string,
): void {
  for (const seg of segments) {
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") {
      throw new Error(errMsg(base, svc, parsed.reason));
    }
    if (parsed.kind === "literal") continue;
    const { name, greedy } = parsed;
    if (greedy) {
      throw new Error(
        errMsg(
          base,
          svc,
          `greedy parameter {${name}${greedy}} is not allowed in base URL path`,
        ),
      );
    }
    if (paramNames.has(name)) {
      throw new Error(
        errMsg(base, svc, `duplicate parameter name "{${name}}"`),
      );
    }
    paramNames.add(name);
  }
}

/**
 * Validate parameter segments in a firewall base URL.
 *
 * Host portion: `{param}`, `{param+}`, `{param*}` allowed.
 *   - Greedy (`+`/`*`) must be in the leftmost (first) host segment.
 *   - At least one static host segment is required for security.
 *
 * Path portion: only `{param}` (single-segment) allowed.
 *   - Greedy (`+`/`*`) is rejected — it would consume the entire remaining
 *     path, leaving nothing for permission rules to match against.
 */
function validateBaseUrlParams(base: string, serviceName: string): void {
  const schemeEnd = base.indexOf("://");
  if (schemeEnd === -1) {
    throw new Error(errMsg(base, serviceName, "missing scheme"));
  }
  if (base.slice(0, schemeEnd).includes("{")) {
    throw new Error(
      errMsg(base, serviceName, "scheme must not contain parameters"),
    );
  }
  if (base.includes("?")) {
    throw new Error(errMsg(base, serviceName, "must not contain query string"));
  }
  if (base.includes("#")) {
    throw new Error(errMsg(base, serviceName, "must not contain fragment"));
  }

  const rest = base.slice(schemeEnd + 3);
  const slashIdx = rest.indexOf("/");
  const host = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const path = slashIdx === -1 ? "" : rest.slice(slashIdx);

  const paramNames = new Set<string>();
  validateHostParams(host.split("."), paramNames, base, serviceName);
  if (path) {
    validatePathParams(
      path.split("/").filter(Boolean),
      paramNames,
      base,
      serviceName,
    );
  }
}

export function validateBaseUrl(base: string, serviceName: string): void {
  // Template base URLs are validated after variable resolution at compose time.
  if (hasBaseUrlVars(base)) return;

  // Parameterized base URLs have their own validation path.
  if (hasBaseUrlParams(base)) {
    validateBaseUrlParams(base, serviceName);
    return;
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    if (!base.includes("://")) {
      throw new Error(
        `Invalid base URL "${base}" in firewall "${serviceName}": URL must include a scheme (e.g. "https://${base}")`,
      );
    }
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": not a valid URL`,
    );
  }
  if (url.search) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain query string`,
    );
  }
  if (url.hash) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain fragment`,
    );
  }
}

/**
 * Expanded firewall config stored in compose content.
 * Resolved from firewall name + FirewallConfig at compose time, then frozen.
 *
 * - `name`: firewall config name (e.g., "slack"). Also the key used in
 *   vm0.yaml to reference this firewall config, and the map key in
 *   `FirewallPolicies` / `NetworkPolicies`.
 * - `description`: optional description from the firewall config
 */
export interface ExpandedFirewallConfig {
  name: string;
  description?: string;
  apis: FirewallApi[];
  placeholders?: Record<string, string>;
  /**
   * Optional per-firewall default permission overrides for auto-generated
   * model-provider firewalls (which otherwise default to fully permissive).
   * Permission names listed in `deny`/`ask` are routed accordingly; all
   * others remain allowed. `unknownPolicy` controls handling of base-URL
   * matches that don't match any permission rule. Ignored on the connector
   * firewall path (which uses stored per-user policies instead).
   */
  defaultPolicies?: {
    deny?: string[];
    ask?: string[];
    unknownPolicy?: FirewallPolicyValue;
  };
}
