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

/**
 * Create a fresh RegExp matching `${{ basic(username, password) }}` templates.
 * Each side is secrets.X, vars.X, "literal", or empty; comma is always required.
 * Returns a new instance each time to avoid `.lastIndex` state leaking
 * between callers when the `/g` flag is used.
 * Groups: (1) ns1, (2) key1, (3) lit1, (4) ns2, (5) key2, (6) lit2 — all optional.
 * Literal strings forbid `"` and `\` to keep the regex simple, and are
 * not subject to further template resolution (the resolver processes
 * basic() before simple templates so literals stay literal).
 *
 * Shared between build-time secret extraction and runtime template resolution.
 */
export function basicAuthTemplateRe(): RegExp {
  return /\$\{\{\s*basic\(\s*(?:(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)|"([^"\\]*)")?\s*,\s*(?:(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)|"([^"\\]*)")?\s*\)\s*\}\}/g;
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
      for (const match of value.matchAll(AUTH_SECRET_PATTERN)) {
        names.add(match[1]!);
      }
      // basic() args may reference secrets, vars, or be string literals;
      // only collect secrets here (vars don't need placeholders, literals
      // are baked into the config).
      for (const match of value.matchAll(basicAuthTemplateRe())) {
        if (match[1] === "secrets" && match[2]) names.add(match[2]);
        if (match[4] === "secrets" && match[5]) names.add(match[5]);
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
}
