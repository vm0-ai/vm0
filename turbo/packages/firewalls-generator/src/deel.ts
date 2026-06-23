/**
 * Generate Deel firewall config from official OpenAPI spec.
 *
 * Data source: https://developer.deel.com/openapi.json
 *
 * Deel publishes OpenAPI specs for their REST API v2. Scopes are embedded
 * in endpoint description text as: **Token scopes**: `scope:action`
 * (not in the OpenAPI security field). We extract them via regex.
 *
 * Endpoints without scopes are tracked in SCOPELESS_ENDPOINTS — unknown
 * scopeless endpoints cause a build error.
 */

import {
  ALL_METHODS,
  listCachedSpecs,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

// Deel splits their API into multiple OpenAPI specs. The update-specs script
// discovers them from the docs index page and caches each one; we just
// merge paths from all cached entries here (later spec wins on overlap).

const PLACEHOLDER_VALUE =
  "CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafe";

// ── OpenAPI types ────────────────────────────────────────────────────────

interface DeelSpec {
  paths?: Record<string, Record<string, DeelOperation>>;
}

interface DeelOperation {
  description?: string;
  operationId?: string;
  tags?: string[];
}

interface DeelOwnerContext {
  readonly rule: string;
  readonly method: string;
  readonly tags: readonly string[];
  readonly operationId: string | null;
}

interface DeelScope {
  readonly scope: string;
  readonly family: string;
  readonly action: string;
}

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const DEEL_TAG_OWNER_PREFERENCES = new Map<string, readonly string[]>([
  ["subpackage_contracts", ["contracts", "worker", "benefits"]],
  ["subpackage_contractorAmendments", ["contracts"]],
  ["subpackage_contractorHiring", ["contracts", "worker"]],
  ["subpackage_eorOffboarding", ["contracts", "worker"]],
  ["subpackage_eorProjectAssignment", ["contracts"]],
  ["subpackage_eorTerminations", ["contracts"]],
  ["subpackage_groups", ["groups"]],
  ["subpackage_hrxDocuments", ["contracts", "worker"]],
  ["subpackage_invoiceAdjustments", ["invoice-adjustments", "worker"]],
  ["subpackage_legalEntities", ["legal-entity", "organizations", "accounting"]],
  ["subpackage_offboarding", ["people", "contracts"]],
  ["subpackage_onboarding", ["people", "contracts"]],
  ["subpackage_payouts", ["worker"]],
  ["subpackage_people", ["people", "worker"]],
  ["subpackage_screenings", ["screenings", "worker"]],
  ["subpackage_timeOff", ["time-off", "worker"]],
]);

// ── Scope extraction ─────────────────────────────────────────────────────

// Matches: **Token scopes**: `scope:action`
// Also handles multiple scopes: `scope1:read`, `scope2:write`
const SCOPE_REGEX = /`([a-z][a-z0-9-]*:[a-z]+)`/g;
const HAS_TOKEN_SCOPES = /\*\*Token scopes?\*\*/i;

function extractScopes(description: string): string[] {
  const markerMatch = HAS_TOKEN_SCOPES.exec(description);
  if (!markerMatch) return [];
  // Only scan text after the "Token scopes" marker
  const afterMarker = description.slice(
    markerMatch.index + markerMatch[0].length,
  );
  const scopes: string[] = [];
  for (const match of afterMarker.matchAll(SCOPE_REGEX)) {
    const scope = match[1];
    if (scope) scopes.push(scope);
  }
  return scopes;
}

function parseScope(scope: string): DeelScope {
  const separatorIndex = scope.lastIndexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Invalid Deel scope "${scope}"`);
  }
  return {
    scope,
    family: scope.slice(0, separatorIndex),
    action: scope.slice(separatorIndex + 1),
  };
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function scopeActionRank(method: string, scope: DeelScope): number {
  if (READ_METHODS.has(method)) {
    if (scope.action === "read") return 0;
    if (scope.action === "write") return 1;
    return 2;
  }
  if (scope.action === "write") return 0;
  if (scope.action === "read") return 1;
  return 2;
}

function pickPreferredScopeInSet(
  scopes: readonly string[],
  context: DeelOwnerContext,
): string {
  const ranked = uniqueValues(scopes)
    .map((scope) => {
      return parseScope(scope);
    })
    .sort((left, right) => {
      const actionDifference =
        scopeActionRank(context.method, left) -
        scopeActionRank(context.method, right);
      if (actionDifference !== 0) return actionDifference;
      return left.scope.localeCompare(right.scope);
    });

  const first = ranked[0];
  if (!first) {
    throw new Error(`No Deel scopes available for ${context.rule}`);
  }

  return first.scope;
}

function pickPrimaryDeelScope(
  scopes: readonly string[],
  context: DeelOwnerContext,
): string | null {
  const candidates = uniqueValues(scopes);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  for (const tag of context.tags) {
    const preferredFamilies = DEEL_TAG_OWNER_PREFERENCES.get(tag);
    if (!preferredFamilies) continue;
    for (const family of preferredFamilies) {
      const matchingScopes = candidates.filter((scope) => {
        return parseScope(scope).family === family;
      });
      if (matchingScopes.length > 0) {
        return pickPreferredScopeInSet(matchingScopes, context);
      }
    }
  }

  const families = uniqueValues(
    candidates.map((scope) => {
      return parseScope(scope).family;
    }),
  );
  if (families.length === 1) {
    return pickPreferredScopeInSet(candidates, context);
  }

  const ranked = candidates
    .map((scope) => {
      return parseScope(scope);
    })
    .sort((left, right) => {
      const actionDifference =
        scopeActionRank(context.method, left) -
        scopeActionRank(context.method, right);
      if (actionDifference !== 0) return actionDifference;
      return left.scope.localeCompare(right.scope);
    });
  const first = ranked[0];
  const second = ranked[1];
  if (
    first &&
    second &&
    scopeActionRank(context.method, first) !==
      scopeActionRank(context.method, second)
  ) {
    return first.scope;
  }

  throw new Error(
    [
      `Ambiguous Deel scope owner for ${context.rule}`,
      context.operationId ? `operation: ${context.operationId}` : null,
      context.tags.length > 0 ? `tags: ${context.tags.join(", ")}` : null,
      `scopes: ${candidates.join(", ")}`,
    ]
      .filter((part) => {
        return part !== null;
      })
      .join("; "),
  );
}

function expandRuntimeRule(rule: string): string[] {
  const spaceIndex = rule.indexOf(" ");
  const method = rule.slice(0, spaceIndex);
  const path = rule.slice(spaceIndex + 1);
  if (method !== "ANY") return [rule];
  return RUNTIME_METHODS.map((runtimeMethod) => {
    return `${runtimeMethod} ${path}`;
  });
}

function assertUniqueDeelRules(permissions: readonly PermissionGroup[]): void {
  const owners = new Map<string, string>();
  const duplicates: string[] = [];

  for (const permission of permissions) {
    for (const rule of permission.rules) {
      for (const runtimeRule of expandRuntimeRule(rule)) {
        const existing = owners.get(runtimeRule);
        if (existing) {
          duplicates.push(`${runtimeRule}: ${existing}, ${permission.name}`);
          continue;
        }
        owners.set(runtimeRule, permission.name);
      }
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      "Deel generated duplicate firewall route owners:\n" +
        duplicates
          .sort((left, right) => {
            return left.localeCompare(right);
          })
          .map((duplicate) => {
            return `  - ${duplicate}`;
          })
          .join("\n"),
    );
  }
}

// ── Scope overrides ──────────────────────────────────────────────────────
// Endpoints without documented scopes that should still be accessible.
// Reuse scopes from matching documented operations for the same resource/action.

const SCOPE_OVERRIDES: Record<string, string> = {
  // Lookups — read-only reference data
  "GET /rest/v2/lookups/countries": "lookups:read",
  "GET /rest/v2/lookups/currencies": "lookups:read",
  "GET /rest/v2/lookups/job-titles": "lookups:read",
  "GET /rest/v2/lookups/seniorities": "lookups:read",
  "GET /rest/v2/lookups/time-off-types": "lookups:read",
  // Webhooks management
  "GET /rest/v2/webhooks": "webhooks:read",
  "GET /rest/v2/webhooks/{id}": "webhooks:read",
  "GET /rest/v2/webhooks/events/types": "webhooks:read",
  "POST /rest/v2/webhooks": "webhooks:write",
  "PATCH /rest/v2/webhooks/{id}": "webhooks:write",
  "DELETE /rest/v2/webhooks/{id}": "webhooks:write",
  // Immigration (scopes present in old combined spec but missing in new split specs)
  "GET /rest/v2/immigration/workers/{worker_id}/required-documents":
    "workers:read",
  "POST /rest/v2/immigration/workers/documents": "workers:write",
  // HRIS organization structures / positions (duplicate parameter-name variants
  // missing scopes in split specs)
  "DELETE /rest/v2/hris/organization_structures/{hrisOrgStr_id}":
    "organizations:write",
  "GET /rest/v2/hris/organization_structures/{hrisOrgStr_id}":
    "organizations:read",
  "PATCH /rest/v2/hris/organization_structures/{hrisOrgStr_id}":
    "organizations:write",
  "GET /rest/v2/hris/positions/profile/{hrisProfileId}": "profile:read",
};

// ── Scopeless endpoints ──────────────────────────────────────────────────
// Endpoints that are intentionally denied (different auth or sensitive).
// Unknown scopeless endpoints cause a build error.

const SCOPELESS_ENDPOINTS = new Set([
  // SCIM user provisioning (uses SCIM token, not API token scopes)
  "GET /rest/v2/Users",
  "GET /rest/v2/Users/{hrisProfileOid}",
  "GET /rest/v2/Users/{hris_profile_id}",
  "POST /rest/v2/Users",
  "POST /rest/v2/Users/.search",
  "PUT /rest/v2/Users/{hrisProfileOid}",
  "PATCH /rest/v2/Users/{hrisProfileOid}",
  "DELETE /rest/v2/Users/{hrisProfileOid}",
  "GET /rest/v2/ServiceProviderConfig",
  // Consent / auth (sensitive)
  "GET /rest/v2/integrations/consent",
  "POST /rest/v2/consent_token",
  // Misc (sensitive operations without documented scopes)
  "POST /rest/v2/eor/employment_cost",
  "POST /rest/v2/worker",
]);

// ── Grouping ─────────────────────────────────────────────────────────────

function buildGroups(spec: DeelSpec): {
  permissions: PermissionGroup[];
  scopeless: string[];
} {
  const groups = new Map<string, Set<string>>();
  const unknownScopeless: string[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!ALL_METHODS.has(method)) continue;

      const httpMethod = method.toUpperCase();
      const rule = `${httpMethod} /rest/v2${path}`;
      const description = op.description ?? "";
      const scopes = extractScopes(description);

      // Apply manual overrides for endpoints missing scopes in spec
      const override = SCOPE_OVERRIDES[rule];
      if (override) {
        if (scopes.length > 0) {
          throw new Error(
            `Stale Deel scope override for ${rule}: official scopes are ${scopes.join(
              ", ",
            )}`,
          );
        }
        scopes.push(override);
      }

      if (scopes.length === 0) {
        if (!SCOPELESS_ENDPOINTS.has(rule)) {
          unknownScopeless.push(rule);
        }
        continue;
      }

      const primaryScope = pickPrimaryDeelScope(scopes, {
        rule,
        method: httpMethod,
        tags: op.tags ?? [],
        operationId: op.operationId ?? null,
      });

      if (!primaryScope) {
        continue;
      }

      let ruleSet = groups.get(primaryScope);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(primaryScope, ruleSet);
      }
      ruleSet.add(rule);
    }
  }

  const permissions = [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      rules: sanitizeAndSortRules([...ruleSet]),
    }));

  assertUniqueDeelRules(permissions);
  return { permissions, scopeless: unknownScopeless };
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from Deel's official OpenAPI specs.",
    "// Source: https://developer.deel.com/openapi.json",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:deel",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const deelFirewall = {",
    '  name: "deel",',
    '  description: "Deel API",',
    "  placeholders: {",
    `    DEEL_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.letsdeel.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.DEEL_TOKEN }}",',
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
  const cachedSpecs = listCachedSpecs("deel");
  console.error(`  Loading ${cachedSpecs.length} cached specs`);

  const specs = cachedSpecs.map(({ key, content }) => {
    const json: unknown = JSON.parse(content);
    if (typeof json !== "object" || json === null || !("paths" in json)) {
      throw new Error(`Invalid OpenAPI spec ${key}: missing paths`);
    }
    return json as DeelSpec;
  });

  const merged: DeelSpec = { paths: {} };
  for (const spec of specs) {
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      if (!merged.paths![path]) {
        merged.paths![path] = {};
      }
      Object.assign(merged.paths![path], methods);
    }
  }

  const spec = merged;
  const pathCount = Object.keys(spec.paths ?? {}).length;
  console.error(`  ${pathCount} endpoints (merged from ${specs.length} specs)`);

  const { permissions, scopeless } = buildGroups(spec);

  if (scopeless.length > 0) {
    // First run: print scopeless endpoints so they can be added to the set
    console.error(
      `\n  ${scopeless.length} endpoints without scopes (add to SCOPELESS_ENDPOINTS):`,
    );
    for (const ep of scopeless.sort()) {
      console.error(`    "${ep}",`);
    }
    throw new Error(
      `${scopeless.length} unknown scopeless endpoints found.\n` +
        "Add them to SCOPELESS_ENDPOINTS in deel.ts to fix this error.",
    );
  }

  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("deel", ts, import.meta.dirname);
}
