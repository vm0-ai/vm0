/**
 * Generate the Google Docs firewall config.
 *
 * Google Docs Discovery method scopes are OAuth authorization constraints, not
 * vm0 firewall permission groups. Keep route coverage official by loading Docs
 * Discovery, but keep the firewall permission taxonomy explicit here.
 */

import {
  escapeString,
  fetchSpec,
  logStats,
  renderDefaultAllowed,
  renderDefaultUnknownPolicy,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

type GoogleDocsRouteKeyKind = "base";

interface DiscoveryMethod {
  id?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleDocsDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleDocsManifestPermission {
  readonly name: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

interface ApiEntry {
  readonly base: string;
  readonly kind: GoogleDocsRouteKeyKind;
  readonly permissions: readonly PermissionGroup[];
}

export const GOOGLE_DOCS_DISCOVERY_URL =
  "https://docs.googleapis.com/$discovery/rest?version=v1";

const GOOGLE_DOCS_BASE_URL = "https://docs.googleapis.com";
const GOOGLE_DOCS_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_DOCS_PERMISSIONS = ["documents.read"];

export const GOOGLE_DOCS_PERMISSION_MANIFEST: readonly GoogleDocsManifestPermission[] =
  [
    {
      name: "documents.create",
      description: "Create Google Docs documents.",
      routeKeys: ["base:POST /v1/documents"],
    },
    {
      name: "documents.read",
      description: "Read Google Docs documents.",
      routeKeys: ["base:GET /v1/documents/{documentId}"],
    },
    {
      name: "documents.write",
      description: "Apply batch updates to Google Docs documents.",
      routeKeys: ["base:POST /v1/documents/{documentId}:batchUpdate"],
    },
  ];

function extractMethods(
  resources: Record<string, DiscoveryResource>,
): DiscoveryMethod[] {
  const methods: DiscoveryMethod[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.methods) {
      methods.push(...Object.values(resource.methods));
    }
    if (resource.resources) {
      methods.push(...extractMethods(resource.resources));
    }
  }
  return methods;
}

function ruleForMethod(method: DiscoveryMethod): string {
  const httpMethod = method.httpMethod;
  const methodPath = method.flatPath ?? method.path;
  if (!httpMethod || !methodPath) {
    throw new Error(
      `Google Docs method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  const path = methodPath.startsWith("/") ? methodPath : `/${methodPath}`;
  return `${httpMethod.toUpperCase()} ${path}`;
}

export function buildGoogleDocsOfficialRouteKeys(
  discovery: GoogleDocsDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    routeKeys.add(`base:${ruleForMethod(method)}`);
  }
  return routeKeys;
}

function sortedValues(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertUniquePermissionNames(
  manifest: readonly GoogleDocsManifestPermission[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const permission of manifest) {
    if (seen.has(permission.name)) {
      duplicates.add(permission.name);
    }
    seen.add(permission.name);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Google Docs permission manifest has duplicate permission names:\n${sortedValues(duplicates).join("\n")}`,
    );
  }
}

export function validateGoogleDocsPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleDocsManifestPermission[],
): void {
  assertUniquePermissionNames(manifest);

  const assignments = new Map<string, string[]>();
  for (const permission of manifest) {
    for (const routeKey of permission.routeKeys) {
      const assignedPermissions = assignments.get(routeKey) ?? [];
      assignedPermissions.push(permission.name);
      assignments.set(routeKey, assignedPermissions);
    }
  }

  const manifestRouteKeys = new Set(assignments.keys());
  const unknown = sortedValues(
    [...manifestRouteKeys].filter((routeKey) => {
      return !officialRouteKeys.has(routeKey);
    }),
  );
  const missing = sortedValues(
    [...officialRouteKeys].filter((routeKey) => {
      return !manifestRouteKeys.has(routeKey);
    }),
  );
  const duplicates = sortedValues(
    [...assignments.entries()]
      .filter(([, permissions]) => {
        return permissions.length > 1;
      })
      .map(([routeKey, permissions]) => {
        return `${routeKey} -> ${permissions.join(", ")}`;
      }),
  );

  const messages: string[] = [];
  if (unknown.length > 0) {
    messages.push(
      `Unknown Google Docs manifest route keys:\n${unknown.join("\n")}`,
    );
  }
  if (missing.length > 0) {
    messages.push(
      `Missing Google Docs manifest route keys:\n${missing.join("\n")}`,
    );
  }
  if (duplicates.length > 0) {
    messages.push(
      `Duplicate Google Docs manifest route assignments:\n${duplicates.join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function routeKeyParts(routeKey: string): {
  readonly kind: GoogleDocsRouteKeyKind;
  readonly rule: string;
} {
  const separatorIndex = routeKey.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed Google Docs route key: ${routeKey}`);
  }
  const kind = routeKey.slice(0, separatorIndex);
  const rule = routeKey.slice(separatorIndex + 1);
  if (kind !== "base") {
    throw new Error(`Unknown Google Docs route key kind: ${routeKey}`);
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE) \//.test(rule)) {
    throw new Error(`Malformed Google Docs route rule: ${routeKey}`);
  }
  return { kind, rule };
}

function permissionsForKind(kind: GoogleDocsRouteKeyKind): PermissionGroup[] {
  return GOOGLE_DOCS_PERMISSION_MANIFEST.flatMap((permission) => {
    const rules = permission.routeKeys
      .map(routeKeyParts)
      .filter((routeKey) => {
        return routeKey.kind === kind;
      })
      .map((routeKey) => {
        return routeKey.rule;
      });
    if (rules.length === 0) return [];
    return [
      {
        name: permission.name,
        description: permission.description,
        rules: sanitizeAndSortRules(rules),
      },
    ];
  }).sort((left, right) => {
    return left.name.localeCompare(right.name);
  });
}

function generateTypeScript(apis: readonly ApiEntry[]): string {
  const lines: string[] = [
    "// Auto-generated from Google's Docs Discovery API and vm0's Docs permission manifest.",
    `// Source: ${GOOGLE_DOCS_DISCOVERY_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-docs",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const googleDocsFirewall = {",
    '  name: "google-docs",',
    '  description: "Google Docs API",',
    "  placeholders: {",
    `    GOOGLE_DOCS_TOKEN: "${escapeString(GOOGLE_DOCS_TOKEN_PLACEHOLDER)}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of apis) {
    lines.push("    {");
    lines.push(`      base: "${escapeString(api.base)}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      '          Authorization: "Bearer ${{ secrets.GOOGLE_DOCS_TOKEN }}",',
    );
    lines.push("        },");
    lines.push("      },");
    lines.push("      permissions: [");
    lines.push(...renderPermissions([...api.permissions]));
    lines.push("      ],");
    lines.push("    },");
  }

  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push(
    ...renderDefaultAllowed(
      "googleDocsDefaultAllowed",
      "googleDocsFirewall",
      DEFAULT_ALLOWED_GOOGLE_DOCS_PERMISSIONS,
    ),
  );
  lines.push(
    ...renderDefaultUnknownPolicy("googleDocsDefaultUnknownPolicy", "deny"),
  );

  return lines.join("\n");
}

async function loadGoogleDocsDiscovery(): Promise<GoogleDocsDiscoveryDocument> {
  const res = await fetchSpec(
    GOOGLE_DOCS_DISCOVERY_URL,
    "google-docs discovery document",
  );
  return (await res.json()) as GoogleDocsDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGoogleDocsDiscovery();
  const officialRouteKeys = buildGoogleDocsOfficialRouteKeys(discovery);
  validateGoogleDocsPermissionManifest(
    officialRouteKeys,
    GOOGLE_DOCS_PERMISSION_MANIFEST,
  );

  const apis: ApiEntry[] = [
    {
      base: GOOGLE_DOCS_BASE_URL,
      kind: "base",
      permissions: permissionsForKind("base"),
    },
  ];

  const ts = generateTypeScript(apis);
  logStats(
    GOOGLE_DOCS_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-docs", ts, import.meta.dirname);
}
