/**
 * Generate Vercel firewall config from the official OpenAPI spec.
 *
 * Data source: https://openapi.vercel.sh/
 * (Official OpenAPI 3.1.0 spec from Vercel.)
 *
 * Permission groups are derived from tags + HTTP method:
 * - GET/HEAD → {tag}:read
 * - POST/PUT/PATCH/DELETE → {tag}:write
 *
 * Endpoints without tags or without bearerToken security are skipped.
 */

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  fetchSpec,
  logStats,
  renderCategories,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiSpec, PermissionGroup } from "./codegen";

const OPENAPI_URL = "https://openapi.vercel.sh/";

// ── Category assignment ─────────────────────────────────────────────────

const ADMIN_TAGS = new Set([
  "access-groups",
  "authentication",
  "billing",
  "marketplace",
  "projectMembers",
  "security",
  "teams",
]);

const DEPLOY_WRITE_TAGS = new Set([
  "deployments",
  "checks",
  "checks-v2",
  "rolling-release",
]);

function assignCategory(permName: string): string {
  const colonIdx = permName.indexOf(":");
  const tag = colonIdx === -1 ? permName : permName.slice(0, colonIdx);
  const access = colonIdx === -1 ? "" : permName.slice(colonIdx + 1);
  if (permName === "user:write") return "Admin";
  if (ADMIN_TAGS.has(tag)) return "Admin";
  if (access === "write" && DEPLOY_WRITE_TAGS.has(tag)) return "Deploy";
  if (access === "read") return "Read";
  return "Write";
}

const VERCEL_CATEGORY_ORDER = ["Read", "Deploy", "Write", "Admin"];

// Vercel API token placeholder.
// Format: vcp_[A-Za-z0-9]{56} (60 chars total)
const PLACEHOLDER_VALUE =
  "vcp_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeL";

// ── OpenAPI types ────────────────────────────────────────────────────────

interface VercelOperation {
  tags?: string[];
  security?: Array<Record<string, string[]>>;
}

interface VercelOwnerOverride {
  readonly tags: readonly string[];
  readonly permission: string;
}

// ── Grouping ─────────────────────────────────────────────────────────────

const READ_METHODS = new Set(["get", "head"]);
const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

// Vercel tags a few operations with both a broad area and the specific
// resource being changed. Keep each runtime route under one owner while
// validating the official tag set still matches the override.
const OWNER_OVERRIDES = new Map<string, VercelOwnerOverride>([
  [
    "PATCH /v1/deployments/{deploymentId}/integrations/{integrationConfigurationId}/resources/{resourceId}/actions/{action}",
    {
      tags: ["deployments", "integrations"],
      permission: "integrations:write",
    },
  ],
  [
    "PATCH /v1/projects/{idOrName}/shared-connect-links",
    {
      tags: ["networking", "static-ips"],
      permission: "static-ips:write",
    },
  ],
]);

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right);
  });
}

function formatList(values: readonly string[]): string {
  return values.join(", ");
}

function permissionNameForTag(tag: string, access: string): string {
  return `${tag}:${access}`;
}

function operationKey(methodLower: string, apiPath: string): string {
  return `${methodLower.toUpperCase()} ${apiPath}`;
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

function resolveOwnerPermissions(
  apiPath: string,
  methodLower: string,
  tags: readonly string[],
  access: string,
  usedOwnerOverrides: Set<string>,
): string[] {
  const ownerPermissions = uniqueSorted(
    tags.map((tag) => {
      return permissionNameForTag(tag, access);
    }),
  );
  const key = operationKey(methodLower, apiPath);
  const override = OWNER_OVERRIDES.get(key);
  if (!override) return ownerPermissions;

  usedOwnerOverrides.add(key);

  const expectedOwnerPermissions = uniqueSorted(
    override.tags.map((tag) => {
      return permissionNameForTag(tag, access);
    }),
  );
  if (!sameValues(ownerPermissions, expectedOwnerPermissions)) {
    throw new Error(
      `Vercel operation "${key}" owner override tags changed: expected [${formatList(
        expectedOwnerPermissions,
      )}], got [${formatList(ownerPermissions)}]`,
    );
  }

  if (!expectedOwnerPermissions.includes(override.permission)) {
    throw new Error(
      `Vercel operation "${key}" owner override permission "${
        override.permission
      }" is not one of [${formatList(expectedOwnerPermissions)}]`,
    );
  }

  return [override.permission];
}

function assertAllOwnerOverridesUsed(usedOwnerOverrides: Set<string>): void {
  const unused = [...OWNER_OVERRIDES.keys()].filter((key) => {
    return !usedOwnerOverrides.has(key);
  });
  if (unused.length === 0) return;

  throw new Error(
    "Vercel owner overrides no longer match official operations:\n" +
      unused
        .sort((left, right) => {
          return left.localeCompare(right);
        })
        .map((key) => {
          return `  - ${key}`;
        })
        .join("\n"),
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

function assertUniqueVercelRules(
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
      "Vercel generated duplicate firewall route owners:\n" +
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

function buildGroups(spec: OpenApiSpec): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  const usedOwnerOverrides = new Set<string>();
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

      const operation: VercelOperation = op;

      // Skip endpoints without bearerToken security
      const hasBearerToken = operation.security?.some(
        (s) => "bearerToken" in s,
      );
      if (!hasBearerToken) continue;

      const tags = operation.tags ?? [];
      if (tags.length === 0) continue;

      const access = READ_METHODS.has(methodLower) ? "read" : "write";
      const rule = `${methodLower.toUpperCase()} ${apiPath}`;
      const ownerPermissions = resolveOwnerPermissions(
        apiPath,
        methodLower,
        tags,
        access,
        usedOwnerOverrides,
      );

      for (const groupName of ownerPermissions) {
        let ruleSet = groups.get(groupName);
        if (!ruleSet) {
          ruleSet = new Set();
          groups.set(groupName, ruleSet);
        }
        ruleSet.add(rule);
      }
    }
  }

  assertAllOwnerOverridesUsed(usedOwnerOverrides);

  const permissions = [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      rules: sanitizeAndSortRules([...ruleSet]),
    }));

  assertUniqueVercelRules(permissions);

  return permissions;
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from Vercel's official OpenAPI spec.",
    `// Source: ${OPENAPI_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:vercel",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, PermissionNamesOf } from "../firewall-types";',
    "",
    "export const vercelFirewall = {",
    '  name: "vercel",',
    '  description: "Vercel API",',
    "  placeholders: {",
    `    VERCEL_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.vercel.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.VERCEL_TOKEN }}",',
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

  // Build categories from generated permissions
  const categoryMap: Record<string, string> = {};
  for (const perm of permissions) {
    categoryMap[perm.name] = assignCategory(perm.name);
  }

  lines.push(
    ...renderCategories("vercelCategories", "vercelFirewall", {
      categories: categoryMap,
      displayOrder: VERCEL_CATEGORY_ORDER,
    }),
  );

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  const res = await fetchSpec(OPENAPI_URL, "Vercel OpenAPI spec");
  const spec = (await res.json()) as OpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissions = buildGroups(spec);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("vercel", ts);
}
