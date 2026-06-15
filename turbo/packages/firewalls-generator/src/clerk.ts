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
  fetchSpec,
  logStats,
  renderCategories,
  renderDefaultAllowed,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiSpec, PermissionGroup } from "./codegen";

const OPENAPI_URL =
  "https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2025-11-10.yml";

// Clerk Secret Key placeholder.
// Format: sk_test_[A-Za-z0-9]{40} or sk_live_[A-Za-z0-9]{40} (~50 chars).
// We use the test prefix in placeholders so an accidental leak is harmless.
const PLACEHOLDER_VALUE = "sk_test_CoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

interface ClerkOperation {
  tags?: string[];
}

interface ClerkSpec extends OpenApiSpec {
  servers?: Array<{ url: string }>;
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

function buildGroups(spec: ClerkSpec): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
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

      for (const tag of tags) {
        const groupName = `${slugifyTag(tag)}:${access}`;
        let ruleSet = groups.get(groupName);
        if (!ruleSet) {
          ruleSet = new Set();
          groups.set(groupName, ruleSet);
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
    `// Source: ${OPENAPI_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:clerk",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
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
  const res = await fetchSpec(OPENAPI_URL, "Clerk Backend OpenAPI spec");
  const text = await res.text();
  const spec = parseYaml(text) as ClerkSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissions = buildGroups(spec);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("clerk", ts, import.meta.dirname);
}
