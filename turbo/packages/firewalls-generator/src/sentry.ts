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

      const rule = `${methodLower.toUpperCase()} ${apiPath}`;

      for (const scope of scopes) {
        if (!scopeAllowsMethod(policies, scope, methodLower.toUpperCase())) {
          continue;
        }
        let ruleSet = groups.get(scope);
        if (!ruleSet) {
          ruleSet = new Set();
          groups.set(scope, ruleSet);
        }
        ruleSet.add(rule);
      }
    }
  }

  return [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      rules: sanitizeAndSortRules([...ruleSet]),
    }));
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
  const permissions = buildGroups(spec, policies);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("sentry", ts, import.meta.dirname);
}
