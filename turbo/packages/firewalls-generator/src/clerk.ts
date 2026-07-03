/**
 * Generate Clerk firewall config from the official OpenAPI spec.
 *
 * Data source: https://github.com/clerk/openapi-specs
 * (Backend API spec, MIT-licensed, maintained by Clerk.)
 *
 * Permission groups are derived from OpenAPI tag + HTTP method:
 *   GET / HEAD             → {tag}:read
 *   POST / PUT / PATCH / DELETE → {tag}:write
 *
 * Tag names are slugified to kebab-case (e.g. "Organization Memberships"
 * → "organization-memberships", "Allow-list / Block-list" →
 * "allow-list-block-list").
 *
 * All read permissions are added to DEFAULT_ALLOWED; write permissions
 * default to "deny" and must be opted into per agent. Clerk Secret Keys
 * grant unscoped admin access, so the firewall is the only barrier
 * between an agent and a destructive call like `DELETE /v1/users/{id}`.
 */

import { parse as parseYaml } from "yaml";

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  applyPermissionDescriptions,
  fetchSpec,
  logStats,
  renderCategories,
  renderDefaultAllowed,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiSpec, PermissionGroup } from "./codegen";

export const CLERK_OPENAPI_URL =
  "https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2026-05-12.yml";

// Clerk Secret Key placeholder.
// Format: sk_test_[A-Za-z0-9]{40} or sk_live_[A-Za-z0-9]{40} (~50 chars).
// We use the test prefix in placeholders so an accidental leak is harmless.
const PLACEHOLDER_VALUE = "sk_test_CoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

interface ClerkOperation {
  tags?: string[];
}

interface ClerkOpenApiTag {
  readonly name?: string;
  readonly description?: string;
}

interface ClerkOwnerOverride {
  readonly tags: readonly string[];
  readonly permission: string;
}

interface ClerkSpec extends OpenApiSpec {
  servers?: Array<{ url: string }>;
  tags?: ClerkOpenApiTag[];
}

interface ClerkPermissionGroup extends PermissionGroup {
  readonly tag: string;
}

interface ClerkPermissionOwner {
  readonly permission: string;
  readonly tag: string;
}

/**
 * Extract the path prefix from the spec's first server URL.
 * Clerk's spec declares `servers: [{ url: "https://api.clerk.com/v1" }]`
 * but path keys are server-relative ("/users/count") — rules need the
 * full path under the connector base.
 */
function serverPathPrefix(spec: ClerkSpec): string {
  const serverUrl = spec.servers?.[0]?.url;
  if (!serverUrl) {
    throw new Error("OpenAPI spec has no servers[0].url");
  }
  const url = new URL(serverUrl);
  return url.pathname.replace(/\/$/, "");
}

// ── Slugification ───────────────────────────────────────────────────────

/** Convert an OpenAPI tag to a kebab-case permission slug. */
function slugifyTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

const CLERK_TAG_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  "Admin Portal Link Tokens":
    "Create and revoke single-use admin portal link tokens for Clerk admin portal access.",
};

// Clerk tags nested billing operations as both Users/Organizations and Billing.
// Keep these billing-specific routes under Billing while validating the
// official tag set still matches the override.
const OWNER_OVERRIDES = new Map<string, ClerkOwnerOverride>([
  [
    "GET /organizations/{organization_id}/billing/credits",
    {
      tags: ["Organizations", "Billing"],
      permission: "billing:read",
    },
  ],
  [
    "GET /organizations/{organization_id}/billing/subscription",
    {
      tags: ["Organizations", "Billing"],
      permission: "billing:read",
    },
  ],
  [
    "GET /users/{user_id}/billing/credits",
    {
      tags: ["Users", "Billing"],
      permission: "billing:read",
    },
  ],
  [
    "GET /users/{user_id}/billing/subscription",
    {
      tags: ["Users", "Billing"],
      permission: "billing:read",
    },
  ],
  [
    "POST /organizations/{organization_id}/billing/credits",
    {
      tags: ["Organizations", "Billing"],
      permission: "billing:write",
    },
  ],
  [
    "POST /users/{user_id}/billing/credits",
    {
      tags: ["Users", "Billing"],
      permission: "billing:write",
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
  return `${slugifyTag(tag)}:${access}`;
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
): ClerkPermissionOwner[] {
  const ownerTags = uniqueSorted(tags);
  const ownerPermissions = ownerTags.map((tag) => {
    return permissionNameForTag(tag, access);
  });
  const key = operationKey(methodLower, apiPath);
  const override = OWNER_OVERRIDES.get(key);
  if (!override) {
    return ownerTags.map((tag, index) => {
      return {
        permission: ownerPermissions[index]!,
        tag,
      };
    });
  }

  usedOwnerOverrides.add(key);

  const expectedOwnerPermissions = uniqueSorted(
    override.tags.map((tag) => {
      return permissionNameForTag(tag, access);
    }),
  );
  if (!sameValues(ownerPermissions, expectedOwnerPermissions)) {
    throw new Error(
      `Clerk operation "${key}" owner override tags changed: expected [${formatList(
        expectedOwnerPermissions,
      )}], got [${formatList(ownerPermissions)}]`,
    );
  }

  if (!expectedOwnerPermissions.includes(override.permission)) {
    throw new Error(
      `Clerk operation "${key}" owner override permission "${
        override.permission
      }" is not one of [${formatList(expectedOwnerPermissions)}]`,
    );
  }

  const sourceTag = override.tags.find((tag) => {
    return permissionNameForTag(tag, access) === override.permission;
  });
  if (!sourceTag) {
    throw new Error(
      `Clerk operation "${key}" owner override permission "${override.permission}" has no source tag`,
    );
  }

  return [
    {
      permission: override.permission,
      tag: sourceTag,
    },
  ];
}

function assertAllOwnerOverridesUsed(usedOwnerOverrides: Set<string>): void {
  const unused = [...OWNER_OVERRIDES.keys()].filter((key) => {
    return !usedOwnerOverrides.has(key);
  });
  if (unused.length === 0) return;

  throw new Error(
    "Clerk owner overrides no longer match official operations:\n" +
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

function assertUniqueClerkRules(permissions: readonly PermissionGroup[]): void {
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
      "Clerk generated duplicate firewall route owners:\n" +
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

function recordPermissionTag(
  permissionTags: Map<string, string>,
  permission: string,
  tag: string,
): void {
  const existingTag = permissionTags.get(permission);
  if (!existingTag) {
    permissionTags.set(permission, tag);
    return;
  }
  if (existingTag === tag) {
    return;
  }
  throw new Error(
    `Clerk permission "${permission}" has ambiguous source tags: ${existingTag}, ${tag}`,
  );
}

function buildGroups(spec: ClerkSpec): ClerkPermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  const permissionTags = new Map<string, string>();
  const usedOwnerOverrides = new Set<string>();
  if (!spec.paths) {
    throw new Error("OpenAPI spec has no 'paths'");
  }
  const prefix = serverPathPrefix(spec);

  for (const [apiPath, methods] of Object.entries(spec.paths)) {
    for (const [methodLower, op] of Object.entries(methods)) {
      if (typeof op !== "object" || op === null) continue;
      if (!ALL_METHODS.has(methodLower)) {
        if (OPENAPI_PATH_KEYS.has(methodLower) || methodLower.startsWith("x-"))
          continue;
        throw new Error(`Unexpected key '${methodLower}' on ${apiPath}`);
      }

      const operation: ClerkOperation = op;
      const tags = operation.tags ?? [];
      if (tags.length === 0) continue;

      const access = READ_METHODS.has(methodLower) ? "read" : "write";
      const rule = `${methodLower.toUpperCase()} ${prefix}${apiPath}`;
      const ownerPermissions = resolveOwnerPermissions(
        apiPath,
        methodLower,
        tags,
        access,
        usedOwnerOverrides,
      );

      for (const owner of ownerPermissions) {
        recordPermissionTag(permissionTags, owner.permission, owner.tag);
        let ruleSet = groups.get(owner.permission);
        if (!ruleSet) {
          ruleSet = new Set();
          groups.set(owner.permission, ruleSet);
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
      tag: permissionTags.get(name) ?? "",
      rules: sanitizeAndSortRules([...ruleSet]),
    }));

  const missingSourceTags = permissions
    .filter((permission) => {
      return permission.tag.length === 0;
    })
    .map((permission) => {
      return permission.name;
    });
  if (missingSourceTags.length > 0) {
    throw new Error(
      "Clerk generated permissions are missing source tags:\n" +
        missingSourceTags
          .sort((left, right) => {
            return left.localeCompare(right);
          })
          .join("\n"),
    );
  }

  assertUniqueClerkRules(permissions);

  return permissions;
}

// ── Permission descriptions ─────────────────────────────────────────────

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

function tagDescriptionMap(spec: ClerkSpec): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const tag of spec.tags ?? []) {
    if (typeof tag.name !== "string" || tag.name.length === 0) {
      continue;
    }
    const description =
      typeof tag.description === "string"
        ? normalizeDescription(tag.description)
        : "";
    if (description.length > 0) {
      descriptions.set(tag.name, description);
    }
  }
  return descriptions;
}

function accessDescriptionPrefix(permission: ClerkPermissionGroup): string {
  const colonIndex = permission.name.lastIndexOf(":");
  const access = colonIndex === -1 ? "" : permission.name.slice(colonIndex + 1);
  if (access === "read") {
    return `Read Clerk ${permission.tag}.`;
  }
  if (access === "write") {
    return `Manage Clerk ${permission.tag}.`;
  }
  throw new Error(
    `Unexpected Clerk permission access for "${permission.name}": ${access}`,
  );
}

function assertNoStaleTagDescriptionOverrides(
  usedTags: ReadonlySet<string>,
): void {
  const staleTags = Object.keys(CLERK_TAG_DESCRIPTION_OVERRIDES).filter(
    (tag) => {
      return !usedTags.has(tag);
    },
  );
  if (staleTags.length === 0) {
    return;
  }
  throw new Error(
    "Clerk tag description overrides reference unused tags:\n" +
      staleTags
        .sort((left, right) => {
          return left.localeCompare(right);
        })
        .join("\n"),
  );
}

function clerkPermissionDescriptions(
  spec: ClerkSpec,
  permissions: readonly ClerkPermissionGroup[],
): Record<string, string> {
  const usedTags = new Set(
    permissions.map((permission) => {
      return permission.tag;
    }),
  );
  assertNoStaleTagDescriptionOverrides(usedTags);

  const tagDescriptions = tagDescriptionMap(spec);
  for (const [tag, description] of Object.entries(
    CLERK_TAG_DESCRIPTION_OVERRIDES,
  )) {
    tagDescriptions.set(tag, description);
  }

  const missingTags = [...usedTags].filter((tag) => {
    return !tagDescriptions.has(tag);
  });
  if (missingTags.length > 0) {
    throw new Error(
      "Clerk OpenAPI tags missing descriptions:\n" +
        missingTags
          .sort((left, right) => {
            return left.localeCompare(right);
          })
          .join("\n"),
    );
  }

  return Object.fromEntries(
    permissions.map((permission) => {
      return [
        permission.name,
        `${accessDescriptionPrefix(permission)} ${tagDescriptions.get(
          permission.tag,
        )}`,
      ];
    }),
  );
}

// ── Category assignment ─────────────────────────────────────────────────
//
// Three buckets surface in the connector settings UI:
//   - "Read"  : every *:read group (always default-allow)
//   - "Write" : everyday write operations (user/org/membership/invitation
//               mutations) — default-deny but commonly opted in
//   - "Admin" : instance-wide configuration, billing, webhooks, JWT
//               templates, OAuth applications — should stay default-deny
//               for most agents even when other writes are enabled

const ADMIN_WRITE_TAGS = new Set([
  "billing",
  "instance-settings",
  "webhooks",
  "jwt-templates",
  "oauth-applications",
  "oauth-access-tokens",
  "saml-connections",
  "enterprise-connections",
  "domains",
  "redirect-urls",
  "email-and-sms-templates",
  "beta-features",
  "proxy-checks",
  "accountless-applications",
  "admin-portal-link-tokens",
  "role-sets",
  "organization-roles",
  "organization-permissions",
  "api-keys",
  "m2m-tokens",
  "machines",
  "testing-tokens",
  "sign-in-tokens",
  "actor-tokens",
  "allow-list-block-list",
  "phone-numbers",
]);

const CATEGORY_ORDER = ["Read", "Write", "Admin"] as const;

function assignCategory(permName: string): string {
  const colonIdx = permName.indexOf(":");
  const tag = colonIdx === -1 ? permName : permName.slice(0, colonIdx);
  const access = colonIdx === -1 ? "" : permName.slice(colonIdx + 1);
  if (access === "read") return "Read";
  if (ADMIN_WRITE_TAGS.has(tag)) return "Admin";
  return "Write";
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const defaultAllowed = permissions
    .filter((p) => p.name.endsWith(":read"))
    .map((p) => p.name);

  const lines: string[] = [
    "// Auto-generated from Clerk's official OpenAPI spec.",
    `// Source: ${CLERK_OPENAPI_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:clerk",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, PermissionNamesOf } from "../firewall-types";',
    "",
    "export const clerkFirewall = {",
    '  name: "clerk",',
    '  description: "Clerk Backend API",',
    "  placeholders: {",
    `    CLERK_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.clerk.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.CLERK_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  lines.push(...renderPermissions(permissions));

  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");

  lines.push(
    ...renderDefaultAllowed(
      "clerkDefaultAllowed",
      "clerkFirewall",
      defaultAllowed,
    ),
  );

  const categoryMap: Record<string, string> = {};
  for (const perm of permissions) {
    categoryMap[perm.name] = assignCategory(perm.name);
  }

  lines.push(
    ...renderCategories("clerkCategories", "clerkFirewall", {
      categories: categoryMap,
      displayOrder: [...CATEGORY_ORDER],
    }),
  );

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  const res = await fetchSpec(CLERK_OPENAPI_URL, "Clerk Backend OpenAPI spec");
  const text = await res.text();
  const spec = parseYaml(text) as ClerkSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const groups = buildGroups(spec);
  const permissions = applyPermissionDescriptions(
    "Clerk",
    groups,
    clerkPermissionDescriptions(spec, groups),
  );
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("clerk", ts);
}
