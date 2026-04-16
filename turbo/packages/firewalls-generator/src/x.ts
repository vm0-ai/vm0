/**
 * Generate X (Twitter) firewall config from the official OpenAPI spec.
 *
 * Data source: https://api.twitter.com/2/openapi.json
 * (Official OpenAPI 3.0.0 spec from X.)
 *
 * Permission groups are derived from OAuth2 scopes defined in the spec's
 * security requirements. Each endpoint declares which scopes it needs via
 * the OAuth2UserToken security scheme — we use those directly as permission
 * group names, matching the pattern used by the Slack generator.
 *
 * Endpoints that only support BearerToken (app-only auth, no user scopes)
 * are grouped under "app-only".
 *
 * X API uses OAuth 2.0 Bearer tokens via Authorization header.
 * Bearer token format (gitleaks: twitter-bearer-token):
 *   22 'A' chars + 80-100 alphanumeric/percent chars (total ~102-122)
 */

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiSpec, PermissionGroup } from "./codegen";

const OPENAPI_URL = "https://api.twitter.com/2/openapi.json";

// Format: A{22} + [a-zA-Z0-9%]{80-100} (gitleaks: twitter-bearer-token)
// e.g. AAAAAAAAAAAAAAAAAAAAAA... + 80 alphanumeric chars
const PLACEHOLDER_VALUE =
  "AAAAAAAAAAAAAAAAAAAAAACoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffe";

// ── OpenAPI types ────────────────────────────────────────────────────────

interface XOperation {
  security?: Array<Record<string, string[]>>;
}

// ── Scope descriptions from OpenAPI spec ─────────────────────────────────

function extractScopeDescriptions(spec: OpenApiSpec): Record<string, string> {
  const oauth = spec.components?.securitySchemes?.["OAuth2UserToken"];
  return oauth?.flows?.authorizationCode?.scopes ?? {};
}

// ── Scope priority for primary-group selection ──────────────────────────
//
// When an endpoint requires multiple OAuth scopes (conjunctive — all must
// be granted), we assign the rule to a single "primary" permission group:
// the scope with the highest priority.
//
// Rationale: X API uses `tweet.read` and `users.read` as broad base scopes
// required by almost every endpoint. The *specific* scope (e.g. `like.write`,
// `dm.read`) describes the actual action and should own the rule for both
// firewall authorization and billing attribution.
//
// If the highest priority is tied, codegen fails — add the new scope to
// the table with a distinct priority. If a scope is missing entirely,
// codegen also fails — add it before regenerating.

const SCOPE_PRIORITY: Record<string, number> = {
  // write scopes — highest (the action the endpoint performs)
  "tweet.write": 100,
  "tweet.moderate.write": 100,
  "like.write": 100,
  "dm.write": 100,
  "follows.write": 100,
  "list.write": 100,
  "bookmark.write": 100,
  "mute.write": 100,
  "block.write": 100,
  "media.write": 100,

  // specific read scopes — the domain-level read capability
  "like.read": 50,
  "dm.read": 50,
  "follows.read": 50,
  "list.read": 50,
  "bookmark.read": 50,
  "block.read": 50,
  "mute.read": 50,
  "space.read": 50,
  "timeline.read": 50,

  // broad read scopes — required by many endpoints as base scopes.
  // Same priority: tie is broken by path-based heuristic below.
  "users.read": 5,
  "tweet.read": 5,
};

// Path prefix → scope mapping for breaking ties between same-priority scopes.
// When two scopes have equal priority, the scope whose prefix matches the
// API path wins.  Entries are checked in order; first match wins.
const PATH_TIEBREAKER: Array<[prefix: string, scope: string]> = [
  ["/2/tweets", "tweet.read"],
  ["/2/users", "users.read"],
  ["/2/communities", "users.read"],
  ["/2/news", "users.read"],
];

/** Look up scope priority; throws on unknown scope for fail-fast. */
export function scopePriority(scope: string, rule: string): number {
  const p = SCOPE_PRIORITY[scope];
  if (p === undefined) {
    throw new Error(
      `Unknown scope "${scope}" on ${rule}. ` +
        `Add it to SCOPE_PRIORITY in x.ts before regenerating.`,
    );
  }
  return p;
}

/**
 * Pick the single primary scope for an endpoint with multiple OAuth scopes.
 * Fails loudly on unknown scopes or unresolvable priority ties.
 */
export function pickPrimaryScope(scopes: string[], rule: string): string {
  if (scopes.length === 1) return scopes[0] ?? "";

  // Validate all scopes and sort by priority descending
  const sorted = [...scopes].sort(
    (a, b) => scopePriority(b, rule) - scopePriority(a, rule),
  );

  const first = sorted[0] ?? "";
  const second = sorted[1] ?? "";

  // No tie → return highest
  if (scopePriority(first, rule) !== scopePriority(second, rule)) {
    return first;
  }

  // Tie: collect all scopes at the top priority
  const topPriority = scopePriority(first, rule);
  const tied = sorted.filter((s) => scopePriority(s, rule) === topPriority);

  // Try path-based tiebreaker: extract path from rule ("METHOD /path")
  const path = rule.split(" ")[1] ?? "";
  for (const [prefix, scope] of PATH_TIEBREAKER) {
    if (path.startsWith(prefix) && tied.includes(scope)) {
      return scope;
    }
  }

  throw new Error(
    `Priority tie between ${tied.map((s) => `"${s}"`).join(", ")} on ${rule}. ` +
      `Add a PATH_TIEBREAKER entry or adjust SCOPE_PRIORITY in x.ts.`,
  );
}

// ── Grouping ─────────────────────────────────────────────────────────────

/** Group name for endpoints that only support app-only (BearerToken) auth. */
const APP_ONLY_GROUP = "app-only";

function buildGroups(spec: OpenApiSpec): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  if (!spec.paths) {
    throw new Error("OpenAPI spec has no 'paths'");
  }

  for (const [apiPath, methods] of Object.entries(spec.paths)) {
    for (const [methodLower, op] of Object.entries(methods)) {
      if (typeof op !== "object" || op === null) continue;
      if (!ALL_METHODS.has(methodLower)) {
        if (OPENAPI_PATH_KEYS.has(methodLower) || methodLower.startsWith("x-"))
          continue;
        throw new Error(`Unexpected key '${methodLower}' on ${apiPath}`);
      }

      const operation: XOperation = op;
      const security = operation.security ?? [];

      // Collect OAuth2 scopes from security requirements
      const oauthScopes = new Set<string>();
      let hasBearerOnly = false;

      for (const scheme of security) {
        if ("OAuth2UserToken" in scheme) {
          for (const scope of scheme["OAuth2UserToken"] ?? []) {
            oauthScopes.add(scope);
          }
        }
        if ("BearerToken" in scheme) {
          hasBearerOnly = true;
        }
      }

      // Skip endpoints with no auth at all
      if (oauthScopes.size === 0 && !hasBearerOnly) continue;

      const rule = `${methodLower.toUpperCase()} ${apiPath}`;

      if (oauthScopes.size > 0) {
        // Assign rule to a single primary scope (highest priority)
        const primary = pickPrimaryScope([...oauthScopes], rule);
        let ruleSet = groups.get(primary);
        if (!ruleSet) {
          ruleSet = new Set();
          groups.set(primary, ruleSet);
        }
        ruleSet.add(rule);
      } else {
        // BearerToken-only endpoint (app-only auth, no user scopes)
        let ruleSet = groups.get(APP_ONLY_GROUP);
        if (!ruleSet) {
          ruleSet = new Set();
          groups.set(APP_ONLY_GROUP, ruleSet);
        }
        ruleSet.add(rule);
      }
    }
  }

  const scopeDescriptions = extractScopeDescriptions(spec);

  return [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => {
      const description =
        name === APP_ONLY_GROUP
          ? "App-only endpoints (no user context required)"
          : scopeDescriptions[name];
      return {
        name,
        ...(description ? { description } : {}),
        rules: sanitizeAndSortRules([...ruleSet]),
      };
    });
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from X (Twitter) official OpenAPI spec.",
    `// Source: ${OPENAPI_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:x",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../contracts/firewalls";',
    "",
    "export const xFirewall = {",
    '  name: "x",',
    '  description: "X (Twitter) API",',
    "  placeholders: {",
    `    X_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.x.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.X_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  lines.push(...renderPermissions(permissions));

  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  const res = await fetchSpec(OPENAPI_URL, "X (Twitter) OpenAPI spec");
  const spec = (await res.json()) as OpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissions = buildGroups(spec);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("x", ts, import.meta.dirname);
}
