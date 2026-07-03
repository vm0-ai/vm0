/**
 * Generate Xero firewall config from official OpenAPI specs.
 *
 * Data source: https://github.com/XeroAPI/Xero-OpenAPI
 *
 * Xero publishes per-API OpenAPI 3.0 specs with OAuth scopes annotated
 * on each operation via the standard `security` field. Scopes follow
 * patterns like `accounting.transactions.read`, `payroll.employees`, etc.
 *
 * Each spec has its own base URL (e.g. api.xro/2.0, assets.xro/1.0),
 * so we generate one `apis` entry per unique base URL.
 *
 * Endpoints without scopes are tracked in INCLUDED_SCOPELESS — unknown
 * scopeless endpoints cause a build error.
 */

import {
  ALL_METHODS,
  applyPermissionDescriptions,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";
import yaml from "yaml";

const REPO = "XeroAPI/Xero-OpenAPI";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/master`;

const PLACEHOLDER_VALUE =
  "CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSaf";

// Spec files to fetch (excluding xero-webhooks.yaml which has no operations)
const SPEC_FILES = [
  "xero_accounting.yaml",
  "xero-app-store.yaml",
  "xero_assets.yaml",
  "xero_bankfeeds.yaml",
  "xero_files.yaml",
  "xero-finance.yaml",
  "xero-identity.yaml",
  "xero-payroll-au.yaml",
  "xero-payroll-au-v2.yaml",
  "xero-payroll-nz.yaml",
  "xero-payroll-uk.yaml",
  "xero-projects.yaml",
];

// ── OpenAPI types ────────────────────────────────────────────────────────

interface XeroOperation {
  security?: Array<Record<string, string[]>>;
}

interface XeroSpec {
  components?: {
    securitySchemes?: {
      OAuth2?: {
        flows?: Record<
          string,
          | {
              scopes?: Record<string, string>;
            }
          | undefined
        >;
      };
    };
  };
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, XeroOperation>>;
}

interface XeroScopeDescription {
  readonly scope: string;
  readonly description: string;
  readonly source: string;
}

// ── Scopeless endpoints ──────────────────────────────────────────────────
// Endpoints without OAuth2 scopes that should still be included in the
// firewall config. Map key = "METHOD /path", value = permission group name.
// The proxy needs these registered so it can inject the Bearer token.
//
// Unknown scopeless endpoints cause a build error — add them here or
// investigate why they lack scopes.

interface IncludedScopelessEndpoint {
  readonly permissionName: string;
  readonly basePath?: string;
}

interface NarrowedRule {
  readonly baseUrl: string;
  readonly rule: string;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

const LEGACY_BROAD_SCOPES = new Set([
  "accounting.attachments",
  "accounting.attachments.read",
  "accounting.contacts",
  "accounting.contacts.read",
  "accounting.reports.read",
  "accounting.settings",
  "accounting.settings.read",
  "accounting.transactions",
  "accounting.transactions.read",
  "assets",
  "assets.read",
  "files",
  "files.read",
  "payroll.employees",
  "payroll.employees.read",
  "payroll.payruns",
  "payroll.payruns.read",
  "payroll.payslip",
  "payroll.payslip.read",
  "payroll.settings",
  "payroll.settings.read",
  "payroll.timesheets",
  "payroll.timesheets.read",
  "projects",
  "projects.read",
]);

const INCLUDED_SCOPELESS = new Map<string, IncludedScopelessEndpoint>([
  // Identity endpoints use openid scopes (not OAuth2) but still need
  // Bearer token auth. Required to retrieve tenant IDs before any
  // accounting API call.
  [
    "GET /Connections",
    { permissionName: "connections", basePath: "/Connections" },
  ],
  [
    "DELETE /Connections/{id}",
    { permissionName: "connections", basePath: "/Connections" },
  ],
]);

// The Xero OpenAPI specs carry most permission descriptions as OAuth scope
// text. These overrides cover local-only permissions and known upstream text
// defects that would otherwise leak into user-facing metadata.
const XERO_PERMISSION_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> =
  {
    "accounting.budgets.read": "Grant read-only access to budgets.",
    "accounting.transactions.read":
      "Grant read-only access to accounting transactions, including bank transactions, credit notes, invoices, payments, purchase orders, quotes, receipts, and related history.",
    connections:
      "List and disconnect Xero tenant connections for the authorized user.",
    "finance.cashvalidation.read":
      "Grant read-only access to bank statement and reconciliation data.",
    "finance.statements.read":
      "Grant read-only access to financial statements.",
    "marketplace.billing":
      "Read Xero App Store subscriptions and manage metered usage records.",
  };

function narrowRuleToBasePath(
  baseUrl: string,
  rule: string,
  basePath: string | undefined,
): NarrowedRule {
  if (basePath === undefined) {
    return { baseUrl, rule };
  }

  const spaceIndex = rule.indexOf(" ");
  const method = rule.slice(0, spaceIndex);
  const path = rule.slice(spaceIndex + 1);
  if (!path.startsWith(basePath)) {
    throw new Error(`${rule} cannot be narrowed to base path ${basePath}`);
  }
  const relativePath = path.slice(basePath.length);
  if (relativePath !== "" && !relativePath.startsWith("/")) {
    throw new Error(`${rule} does not align with base path ${basePath}`);
  }
  return {
    baseUrl: `${baseUrl}${basePath}`,
    rule: `${method} ${relativePath === "" ? "/" : relativePath}`,
  };
}

// ── Grouping ─────────────────────────────────────────────────────────────

interface XeroScopePriority {
  readonly isGranular: boolean;
  readonly segmentCount: number;
}

interface ParsedSpec {
  sourceFile: string;
  baseUrl: string;
  paths: Record<string, Record<string, XeroOperation>>;
  scopeDescriptions: readonly XeroScopeDescription[];
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

function normalizeXeroDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ");
}

function xeroSpecScopeDescriptions(
  sourceFile: string,
  spec: XeroSpec,
): XeroScopeDescription[] {
  const descriptions: XeroScopeDescription[] = [];
  const flows = spec.components?.securitySchemes?.OAuth2?.flows;
  if (!flows) {
    return descriptions;
  }

  for (const [flowName, flow] of Object.entries(flows)) {
    if (!flow?.scopes) {
      continue;
    }
    for (const [scope, description] of Object.entries(flow.scopes)) {
      const normalized = normalizeXeroDescription(description);
      if (normalized === "") {
        continue;
      }
      descriptions.push({
        scope,
        description: normalized,
        source: `${sourceFile}:${flowName}`,
      });
    }
  }

  return descriptions;
}

function collectXeroScopeDescriptions(
  specs: readonly ParsedSpec[],
): ReadonlyMap<string, string> {
  const descriptions = new Map<
    string,
    { readonly description: string; readonly source: string }
  >();
  const conflicts: string[] = [];

  for (const spec of specs) {
    for (const scopeDescription of spec.scopeDescriptions) {
      const existing = descriptions.get(scopeDescription.scope);
      if (existing && existing.description !== scopeDescription.description) {
        conflicts.push(
          `${scopeDescription.scope}: ${existing.description} (${existing.source}) <> ${scopeDescription.description} (${scopeDescription.source})`,
        );
        continue;
      }
      descriptions.set(scopeDescription.scope, {
        description: scopeDescription.description,
        source: scopeDescription.source,
      });
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      "Conflicting Xero OAuth scope descriptions:\n" +
        sortedStrings(conflicts).join("\n"),
    );
  }

  return new Map(
    [...descriptions.entries()].map(([scope, { description }]) => {
      return [scope, description];
    }),
  );
}

function xeroPermissionNames(
  hostGroups: ReadonlyMap<string, readonly PermissionGroup[]>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const permissions of hostGroups.values()) {
    for (const permission of permissions) {
      names.add(permission.name);
    }
  }
  return names;
}

function assertXeroDescriptionOverridesUsed(
  permissionNames: ReadonlySet<string>,
): void {
  const unusedOverrides = sortedStrings(
    Object.keys(XERO_PERMISSION_DESCRIPTION_OVERRIDES).filter((name) => {
      return !permissionNames.has(name);
    }),
  );
  if (unusedOverrides.length > 0) {
    throw new Error(
      "Xero permission description overrides reference unknown permissions:\n" +
        unusedOverrides.join("\n"),
    );
  }
}

function xeroPermissionDescription(
  permissionName: string,
  scopeDescriptions: ReadonlyMap<string, string>,
): string | undefined {
  return (
    XERO_PERMISSION_DESCRIPTION_OVERRIDES[permissionName] ??
    scopeDescriptions.get(permissionName)
  );
}

function describeXeroHostGroups(
  hostGroups: Map<string, PermissionGroup[]>,
  scopeDescriptions: ReadonlyMap<string, string>,
): Map<string, PermissionGroup[]> {
  assertXeroDescriptionOverridesUsed(xeroPermissionNames(hostGroups));

  return new Map(
    [...hostGroups.entries()].map(([baseUrl, permissions]) => {
      const descriptions: Record<string, string> = {};
      for (const permission of permissions) {
        const description = xeroPermissionDescription(
          permission.name,
          scopeDescriptions,
        );
        if (description !== undefined) {
          descriptions[permission.name] = description;
        }
      }
      return [
        baseUrl,
        applyPermissionDescriptions("Xero", permissions, descriptions),
      ];
    }),
  );
}

function isReadScope(scope: string): boolean {
  return scope.endsWith(".read");
}

function methodFromRule(rule: string): string {
  const spaceIndex = rule.indexOf(" ");
  if (spaceIndex === -1) {
    throw new Error(`Malformed Xero rule: ${rule}`);
  }
  return rule.slice(0, spaceIndex);
}

function xeroScopePriority(scope: string): XeroScopePriority {
  return {
    isGranular: !LEGACY_BROAD_SCOPES.has(scope),
    segmentCount: scope.split(".").length,
  };
}

function compareXeroScopePriority(
  left: XeroScopePriority,
  right: XeroScopePriority,
): number {
  if (left.isGranular !== right.isGranular) {
    return left.isGranular ? 1 : -1;
  }
  return left.segmentCount - right.segmentCount;
}

function pickMostSpecificScope(
  scopes: readonly string[],
  rule: string,
): string {
  const ranked = scopes
    .map((scope) => {
      return { scope, priority: xeroScopePriority(scope) };
    })
    .sort((left, right) => {
      const priorityDifference = compareXeroScopePriority(
        right.priority,
        left.priority,
      );
      if (priorityDifference !== 0) return priorityDifference;
      return left.scope.localeCompare(right.scope);
    });

  const first = ranked[0];
  if (!first) {
    throw new Error(`No Xero scopes available for ${rule}`);
  }

  const second = ranked[1];
  if (
    second &&
    compareXeroScopePriority(first.priority, second.priority) === 0
  ) {
    throw new Error(
      `Ambiguous Xero scope owner for ${rule}: ${scopes.join(", ")}`,
    );
  }

  return first.scope;
}

export function pickPrimaryXeroScope(
  scopes: readonly string[],
  rule: string,
): string {
  const uniqueScopes = [...new Set(scopes)];
  if (uniqueScopes.length === 0) {
    throw new Error(`No Xero scopes available for ${rule}`);
  }
  if (uniqueScopes.length === 1) {
    return uniqueScopes[0]!;
  }

  const method = methodFromRule(rule);
  const readScopes = uniqueScopes.filter(isReadScope);
  const nonReadScopes = uniqueScopes.filter((scope) => {
    return !isReadScope(scope);
  });
  const candidates =
    READ_METHODS.has(method) && readScopes.length > 0
      ? readScopes
      : nonReadScopes.length > 0
        ? nonReadScopes
        : readScopes;

  return pickMostSpecificScope(candidates, rule);
}

function addRule(
  groups: Map<string, Map<string, Set<string>>>,
  scope: string,
  baseUrl: string,
  rule: string,
): void {
  let baseMap = groups.get(scope);
  if (!baseMap) {
    baseMap = new Map();
    groups.set(scope, baseMap);
  }
  let ruleSet = baseMap.get(baseUrl);
  if (!ruleSet) {
    ruleSet = new Set();
    baseMap.set(baseUrl, ruleSet);
  }
  ruleSet.add(rule);
}

function assertUniqueHostRules(
  hostGroups: Map<string, PermissionGroup[]>,
): void {
  const duplicates: string[] = [];
  for (const [baseUrl, permissions] of hostGroups) {
    const owners = new Map<string, string>();
    for (const permission of permissions) {
      for (const rule of permission.rules) {
        const existing = owners.get(rule);
        if (existing) {
          duplicates.push(
            `${baseUrl} ${rule}: ${existing}, ${permission.name}`,
          );
          continue;
        }
        owners.set(rule, permission.name);
      }
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      "Xero generated duplicate firewall route owners:\n" +
        duplicates
          .sort((a, b) => {
            return a.localeCompare(b);
          })
          .map((duplicate) => {
            return `  - ${duplicate}`;
          })
          .join("\n"),
    );
  }
}

function buildGroups(specs: ParsedSpec[]): {
  /** Map: baseUrl -> permission groups */
  hostGroups: Map<string, PermissionGroup[]>;
  scopeless: string[];
} {
  // scope -> baseUrl -> rules
  const groups = new Map<string, Map<string, Set<string>>>();
  const unknownScopeless: string[] = [];

  for (const spec of specs) {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!ALL_METHODS.has(method)) continue;

        const httpMethod = method.toUpperCase();
        const rule = `${httpMethod} ${path}`;

        // Extract OAuth scopes from security array
        const scopes: string[] = [];
        if (op.security) {
          for (const req of op.security) {
            // Xero uses "OAuth2" as the scheme name
            const oauthScopes = req["OAuth2"];
            if (oauthScopes) {
              scopes.push(...oauthScopes);
            }
          }
        }

        if (scopes.length === 0) {
          const includedEndpoint = INCLUDED_SCOPELESS.get(rule);
          if (includedEndpoint) {
            const narrowed = narrowRuleToBasePath(
              spec.baseUrl,
              rule,
              includedEndpoint.basePath,
            );
            addRule(
              groups,
              includedEndpoint.permissionName,
              narrowed.baseUrl,
              narrowed.rule,
            );
          } else {
            unknownScopeless.push(`${rule} (${spec.baseUrl})`);
          }
          continue;
        }

        const primaryScope = pickPrimaryXeroScope(scopes, rule);
        addRule(groups, primaryScope, spec.baseUrl, rule);
      }
    }
  }

  // Build per-baseUrl permission groups
  const hostGroups = new Map<string, PermissionGroup[]>();

  // Collect all baseUrls
  const allBaseUrls = new Set<string>();
  for (const baseMap of groups.values()) {
    for (const baseUrl of baseMap.keys()) {
      allBaseUrls.add(baseUrl);
    }
  }

  for (const baseUrl of [...allBaseUrls].sort()) {
    const permissions: PermissionGroup[] = [];

    for (const [scope, baseMap] of [...groups.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const ruleSet = baseMap.get(baseUrl);
      if (!ruleSet || ruleSet.size === 0) continue;

      permissions.push({
        name: scope,
        rules: sanitizeAndSortRules([...ruleSet]),
      });
    }

    if (permissions.length > 0) {
      hostGroups.set(baseUrl, permissions);
    }
  }

  assertUniqueHostRules(hostGroups);

  return { hostGroups, scopeless: unknownScopeless };
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(
  hostGroups: Map<string, PermissionGroup[]>,
): string {
  const lines: string[] = [
    `// Auto-generated from Xero's official OpenAPI specs.`,
    `// Source: https://github.com/${REPO}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:xero",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const xeroFirewall = {",
    '  name: "xero",',
    '  description: "Xero API",',
    "  placeholders: {",
    `    XERO_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
  ];

  for (const [baseUrl, permissions] of hostGroups) {
    lines.push("    {");
    lines.push(`      base: "${baseUrl}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push('          Authorization: "Bearer ${{ secrets.XERO_TOKEN }}",');
    lines.push("        },");
    lines.push("      },");
    lines.push("      permissions: [");
    lines.push(...renderPermissions(permissions));
    lines.push("      ],");
    lines.push("    },");
  }

  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  console.error("Downloading Xero OpenAPI specs…");

  const parsedSpecs = await Promise.all(
    SPEC_FILES.map(async (file): Promise<ParsedSpec | null> => {
      const url = `${RAW_BASE}/${file}`;
      const res = await fetchSpec(url, file);
      const text = await res.text();
      const spec: unknown = yaml.parse(text);

      if (
        typeof spec !== "object" ||
        spec === null ||
        !("paths" in spec) ||
        typeof (spec as XeroSpec).paths !== "object"
      ) {
        console.error(`  Skipping ${file}: no paths`);
        return null;
      }

      const typed = spec as XeroSpec;
      const baseUrl = typed.servers?.[0]?.url;
      if (!baseUrl) {
        throw new Error(`${file}: missing servers[0].url`);
      }
      // Normalize trailing slash
      const normalizedBase = baseUrl.replace(/\/$/, "");

      return {
        sourceFile: file,
        baseUrl: normalizedBase,
        paths: typed.paths ?? {},
        scopeDescriptions: xeroSpecScopeDescriptions(file, typed),
      } satisfies ParsedSpec;
    }),
  );

  const validSpecs = parsedSpecs.filter((s): s is ParsedSpec => s !== null);
  console.error(`  Parsed ${validSpecs.length} specs`);

  const { hostGroups, scopeless } = buildGroups(validSpecs);
  const scopeDescriptions = collectXeroScopeDescriptions(validSpecs);
  const describedHostGroups = describeXeroHostGroups(
    hostGroups,
    scopeDescriptions,
  );

  if (scopeless.length > 0) {
    console.error(
      `\n  ${scopeless.length} endpoints without scopes (add to INCLUDED_SCOPELESS):`,
    );
    for (const ep of scopeless.sort()) {
      console.error(`    "${ep}",`);
    }
    throw new Error(
      `${scopeless.length} unknown scopeless endpoints found.\n` +
        "Add them to INCLUDED_SCOPELESS in xero.ts to fix this error.",
    );
  }

  const ts = generateTypeScript(describedHostGroups);

  const allPerms = [...describedHostGroups.values()].flat();
  logStats(allPerms);
  writeOutput("xero", ts);
}
