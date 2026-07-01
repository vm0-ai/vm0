/**
 * Generate Sentry firewall config from the official OpenAPI spec.
 *
 * Data source: https://github.com/getsentry/sentry-api-schema
 * (Official OpenAPI 3.0.3 spec from Sentry.)
 *
 * Permission groups are derived from auth_token scopes declared on each
 * endpoint (e.g. `alerts:read`, `project:write`, `org:admin`).
 *
 * Endpoints without auth_token security are skipped.
 */

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  applyPermissionDescriptions,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiSpec, PermissionGroup } from "./codegen";

const OPENAPI_URL =
  "https://raw.githubusercontent.com/getsentry/sentry-api-schema/refs/heads/main/openapi-derefed.json";
export const PERMISSIONS_DOC_URL =
  "https://raw.githubusercontent.com/getsentry/sentry-docs/master/docs/api/permissions.mdx";

// Sentry API token placeholder.
// No documented format; generic 32-char alphanumeric
const PLACEHOLDER_VALUE = "CoffeeSafeLocalCoffeeSafeLocalCo";

// ── OpenAPI types ────────────────────────────────────────────────────────

interface SentryOperation {
  security?: Array<Record<string, string[]>>;
  tags?: string[];
  operationId?: string;
}

const SENTRY_SCOPE_LEVELS = {
  read: 0,
  write: 1,
  admin: 2,
} as const;
const SENTRY_HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

type SentryScopeLevelName = keyof typeof SENTRY_SCOPE_LEVELS;
type SentryScopeLevel = (typeof SENTRY_SCOPE_LEVELS)[SentryScopeLevelName];

interface SentryStandardScopePolicy {
  family: string;
  level: SentryScopeLevel;
}

interface SentryPermissionPolicies {
  standardMethods: Map<string, Map<string, SentryScopeLevel>>;
  customMethods: Map<string, Set<string>>;
}

interface SentryOwnerContext {
  readonly rule: string;
  readonly method: string;
  readonly tags: readonly string[];
  readonly operationId: string | null;
}

interface SentryOwnerScopePreference {
  readonly kind: "scope";
  readonly scope: string;
}

interface SentryOwnerFamilyPreference {
  readonly kind: "family";
  readonly family: string;
}

type SentryOwnerPreference =
  | SentryOwnerScopePreference
  | SentryOwnerFamilyPreference;

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const SENTRY_SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "alerts:read":
    "Read alert rules, detectors, monitors, workflows, and check-in status.",
  "alerts:write":
    "Create, update, or delete alert rules, detectors, monitors, and workflows.",
  "event:admin":
    "Administer Sentry issues, including deleting issues and external issue links.",
  "event:read":
    "Read Sentry issues, events, tags, hashes, short IDs, and replay viewer data.",
  "event:write":
    "Update Sentry issues, run issue autofix actions, and create external issue links.",
  "member:admin":
    "Administer organization members and SCIM users, including removals.",
  "member:invite":
    "Invite organization members and update pending member invitations.",
  "member:read": "Read organization member and SCIM user records.",
  "member:write": "Create and update organization members and SCIM users.",
  "org:admin":
    "Delete and administer organization-level resources such as dashboards, saved queries, notifications, external users, and Sentry apps.",
  "org:ci":
    "Use CI and deployment workflows, including releases, deploys, and build artifacts.",
  "org:integrations":
    "Read and manage organization integrations and Sentry app installations.",
  "org:read":
    "Read organization metadata, dashboards, discoveries, projects, teams, replays, events, stats, and related resources.",
  "org:write":
    "Create and update organization-level resources such as dashboards, saved queries, forwarding, teams, workflows, and Sentry apps.",
  "project:admin":
    "Delete and administer project-level resources such as projects, keys, hooks, filters, monitors, releases, rules, and symbol sources.",
  "project:distribution": "Read project build distribution artifacts.",
  "project:read":
    "Read project settings, events, environments, releases, monitors, replays, rules, keys, teams, and user feedback.",
  "project:releases":
    "Read and manage Sentry releases, deploys, release files, commits, and debug symbol files.",
  "project:write":
    "Create and update project settings, events, environments, debug files, hooks, keys, monitors, ownership, rules, symbol sources, teams, and user feedback.",
  "team:admin":
    "Administer teams, SCIM groups, external teams, and team memberships.",
  "team:read": "Read teams, SCIM groups, and team memberships.",
  "team:write":
    "Create and update teams, SCIM groups, external teams, and team memberships.",
};

function preferScope(scope: string): SentryOwnerScopePreference {
  return { kind: "scope", scope };
}

function preferFamily(family: string): SentryOwnerFamilyPreference {
  return { kind: "family", family };
}

const SENTRY_TAG_OWNER_PREFERENCES = new Map<
  string,
  readonly SentryOwnerPreference[]
>([
  ["Users", [preferFamily("org")]],
  ["Organizations", [preferScope("member:invite"), preferFamily("org")]],
  ["Integrations", [preferScope("org:integrations"), preferFamily("org")]],
  ["Integration", [preferScope("org:integrations"), preferFamily("org")]],
  ["Dashboards", [preferFamily("org")]],
  ["Discover", [preferFamily("org")]],
  ["Environments", [preferFamily("org")]],
  ["Explore", [preferFamily("org")]],
  ["Profiling", [preferFamily("org")]],
  ["Replays", [preferFamily("org")]],
  ["Spike Protection", [preferFamily("org")]],
  ["Mobile Builds", [preferScope("project:distribution"), preferFamily("org")]],
  ["Monitors", [preferFamily("alerts")]],
  ["Crons", [preferFamily("alerts")]],
  ["Events", [preferFamily("event")]],
  ["Seer", [preferFamily("event")]],
  [
    "Projects",
    [
      preferScope("org:ci"),
      preferScope("project:releases"),
      preferFamily("project"),
    ],
  ],
  ["Teams", [preferFamily("team")]],
  ["SCIM", [preferFamily("team"), preferFamily("member")]],
  ["Releases", [preferScope("project:releases"), preferFamily("project")]],
  [
    "Snapshots",
    [
      preferScope("org:ci"),
      preferScope("project:releases"),
      preferFamily("project"),
    ],
  ],
]);

function parseScope(scope: string): SentryStandardScopePolicy | null {
  const separatorIndex = scope.lastIndexOf(":");
  if (separatorIndex === -1) return null;

  const family = scope.slice(0, separatorIndex);
  const levelName = scope.slice(separatorIndex + 1);
  if (!isSentryScopeLevelName(levelName)) return null;

  return {
    family,
    level: SENTRY_SCOPE_LEVELS[levelName],
  };
}

function isSentryScopeLevelName(value: string): value is SentryScopeLevelName {
  return Object.hasOwn(SENTRY_SCOPE_LEVELS, value);
}

function parseMethodCell(value: string): string[] {
  const methods = value
    .replace(/\*/g, "")
    .split("/")
    .map((method) => {
      return method.trim().toUpperCase();
    });

  if (
    methods.length === 0 ||
    methods.some((method) => {
      return !SENTRY_HTTP_METHODS.has(method);
    })
  ) {
    return [];
  }

  if (methods.includes("GET") && !methods.includes("HEAD")) {
    methods.push("HEAD");
  }
  if (
    methods.some((method) => {
      return method === "PUT" || method === "POST";
    }) &&
    !methods.includes("PATCH")
  ) {
    methods.push("PATCH");
  }

  return methods;
}

function addStandardPolicy(
  policies: SentryPermissionPolicies,
  method: string,
  family: string,
  level: SentryScopeLevel,
): void {
  let methodLevels = policies.standardMethods.get(family);
  if (!methodLevels) {
    methodLevels = new Map();
    policies.standardMethods.set(family, methodLevels);
  }

  const existingLevel = methodLevels.get(method);
  if (existingLevel === undefined || level < existingLevel) {
    methodLevels.set(method, level);
  }
}

function addCustomPolicy(
  policies: SentryPermissionPolicies,
  method: string,
  scope: string,
): void {
  let methods = policies.customMethods.get(scope);
  if (!methods) {
    methods = new Set();
    policies.customMethods.set(scope, methods);
  }
  methods.add(method);
}

function parsePermissionsDoc(markdown: string): SentryPermissionPolicies {
  const policies: SentryPermissionPolicies = {
    standardMethods: new Map(),
    customMethods: new Map(),
  };
  const tableRowPattern = /^\|\s*(.*?)\s*\|\s*`([^`]+)`\s*\|\s*$/;

  for (const line of markdown.split(/\r?\n/)) {
    const match = tableRowPattern.exec(line);
    if (!match) continue;

    const methods = parseMethodCell(match[1]!);
    if (methods.length === 0) continue;

    const scope = match[2]!.replace(/\s+/g, "");
    const standardScope = parseScope(scope);

    for (const method of methods) {
      if (standardScope) {
        addStandardPolicy(
          policies,
          method,
          standardScope.family,
          standardScope.level,
        );
      } else {
        addCustomPolicy(policies, method, scope);
      }
    }
  }

  if (
    policies.standardMethods.size === 0 &&
    policies.customMethods.size === 0
  ) {
    throw new Error("Sentry permissions doc has no method policies");
  }

  return policies;
}

function scopeAllowsMethod(
  policies: SentryPermissionPolicies,
  scope: string,
  method: string,
): boolean {
  const customMethods = policies.customMethods.get(scope);
  if (customMethods) return customMethods.has(method);

  const standardScope = parseScope(scope);
  if (!standardScope) return true;

  const requiredLevel = policies.standardMethods
    .get(standardScope.family)
    ?.get(method);
  if (requiredLevel === undefined) return true;

  return standardScope.level >= requiredLevel;
}

function scopeFamily(scope: string): string {
  const separatorIndex = scope.lastIndexOf(":");
  return separatorIndex === -1 ? scope : scope.slice(0, separatorIndex);
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pickPreferredStandardScope(
  scopes: readonly string[],
  context: SentryOwnerContext,
): string {
  const ranked = scopes
    .map((scope) => {
      const standardScope = parseScope(scope);
      if (!standardScope) return null;
      return { scope, standardScope };
    })
    .filter((entry) => {
      return entry !== null;
    })
    .sort((left, right) => {
      const levelDifference =
        left.standardScope.level - right.standardScope.level;
      if (levelDifference !== 0) return levelDifference;
      return left.scope.localeCompare(right.scope);
    });

  const first = ranked[0];
  if (!first) {
    throw new Error(`No standard Sentry scopes available for ${context.rule}`);
  }

  const second = ranked[1];
  if (
    second &&
    first.standardScope.level === second.standardScope.level &&
    first.standardScope.family === second.standardScope.family
  ) {
    throw new Error(
      `Ambiguous Sentry scope owner for ${context.rule}: ${scopes.join(", ")}`,
    );
  }

  return first.scope;
}

function pickPreferredScopeInSet(
  scopes: readonly string[],
  context: SentryOwnerContext,
): string {
  const uniqueScopes = uniqueValues(scopes);
  if (uniqueScopes.length === 0) {
    throw new Error(`No Sentry scopes available for ${context.rule}`);
  }
  if (uniqueScopes.length === 1) {
    return uniqueScopes[0]!;
  }

  const standardScopes = uniqueScopes.filter((scope) => {
    return parseScope(scope) !== null;
  });
  if (standardScopes.length > 0) {
    return pickPreferredStandardScope(standardScopes, context);
  }

  throw new Error(
    `Ambiguous Sentry custom scope owner for ${context.rule}: ${uniqueScopes.join(", ")}`,
  );
}

function scopesMatchingPreference(
  scopes: readonly string[],
  preference: SentryOwnerPreference,
): string[] {
  if (preference.kind === "scope") {
    return scopes.includes(preference.scope) ? [preference.scope] : [];
  }
  return scopes.filter((scope) => {
    return scopeFamily(scope) === preference.family;
  });
}

function pickPrimarySentryScope(
  scopes: readonly string[],
  policies: SentryPermissionPolicies,
  context: SentryOwnerContext,
): string | null {
  const candidates = uniqueValues(scopes).filter((scope) => {
    return scopeAllowsMethod(policies, scope, context.method);
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  for (const tag of context.tags) {
    const preferences = SENTRY_TAG_OWNER_PREFERENCES.get(tag);
    if (!preferences) continue;

    for (const preference of preferences) {
      const preferredScopes = scopesMatchingPreference(candidates, preference);
      if (preferredScopes.length === 0) continue;
      return pickPreferredScopeInSet(preferredScopes, context);
    }
  }

  const families = uniqueValues(candidates.map(scopeFamily));
  if (families.length === 1) {
    return pickPreferredScopeInSet(candidates, context);
  }

  throw new Error(
    [
      `Ambiguous Sentry scope owner for ${context.rule}`,
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

function assertUniqueSentryRules(
  permissions: readonly PermissionGroup[],
): void {
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
      "Sentry generated duplicate firewall route owners:\n" +
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

// ── Grouping ─────────────────────────────────────────────────────────────

function buildGroups(
  spec: OpenApiSpec,
  policies: SentryPermissionPolicies,
): PermissionGroup[] {
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

      const operation: SentryOperation = op;

      // Collect all scopes from auth_token security entries
      const scopes = new Set<string>();
      for (const sec of operation.security ?? []) {
        if ("auth_token" in sec) {
          for (const scope of sec["auth_token"]) {
            // Normalize whitespace (e.g. "org: read" → "org:read")
            scopes.add(scope.replace(/\s+/g, ""));
          }
        }
      }
      if (scopes.size === 0) continue;

      const method = methodLower.toUpperCase();
      const rule = `${method} ${apiPath}`;
      const primaryScope = pickPrimarySentryScope([...scopes], policies, {
        rule,
        method,
        tags: operation.tags ?? [],
        operationId: operation.operationId ?? null,
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
  assertUniqueSentryRules(permissions);
  return permissions;
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from Sentry's official OpenAPI spec.",
    `// Source: ${OPENAPI_URL}`,
    `// Permission method policy: ${PERMISSIONS_DOC_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:sentry",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const sentryFirewall = {",
    '  name: "sentry",',
    '  description: "Sentry API",',
    "  placeholders: {",
    `    SENTRY_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://sentry.io",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.SENTRY_TOKEN }}",',
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
  const res = await fetchSpec(OPENAPI_URL, "Sentry OpenAPI spec");
  const spec = (await res.json()) as OpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissionsDocRes = await fetchSpec(
    PERMISSIONS_DOC_URL,
    "Sentry permissions doc",
  );
  const permissionsDoc = await permissionsDocRes.text();
  const policies = parsePermissionsDoc(permissionsDoc);
  const permissions = applyPermissionDescriptions(
    "Sentry",
    buildGroups(spec, policies),
    SENTRY_SCOPE_DESCRIPTIONS,
  );
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("sentry", ts);
}
