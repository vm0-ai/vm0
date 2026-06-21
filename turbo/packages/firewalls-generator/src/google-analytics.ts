/**
 * Generate the Google Analytics firewall config.
 *
 * Google Analytics Discovery method scopes are OAuth authorization
 * constraints, not vm0 firewall permission groups. Keep route coverage
 * official by loading the Data/Admin Discovery documents, but keep the
 * firewall permission taxonomy explicit here.
 */

import {
  escapeString,
  fetchSpec,
  logStats,
  renderCategories,
  renderDefaultAllowed,
  renderDefaultUnknownPolicy,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

type GoogleAnalyticsRouteKeyKind = "data" | "admin";

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

export interface GoogleAnalyticsDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleAnalyticsManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

interface ApiConfig {
  readonly kind: GoogleAnalyticsRouteKeyKind;
  readonly discoveryUrl: string;
  readonly baseUrl: string;
}

interface DiscoveryEntry {
  readonly kind: GoogleAnalyticsRouteKeyKind;
  readonly discovery: GoogleAnalyticsDiscoveryDocument;
}

interface ApiEntry {
  readonly base: string;
  readonly kind: GoogleAnalyticsRouteKeyKind;
  readonly permissions: readonly PermissionGroup[];
}

export const GOOGLE_ANALYTICS_APIS: readonly ApiConfig[] = [
  {
    kind: "data",
    discoveryUrl:
      "https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta",
    baseUrl: "https://analyticsdata.googleapis.com",
  },
  {
    kind: "admin",
    discoveryUrl:
      "https://analyticsadmin.googleapis.com/$discovery/rest?version=v1beta",
    baseUrl: "https://analyticsadmin.googleapis.com",
  },
];

const GOOGLE_ANALYTICS_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_ANALYTICS_PERMISSIONS = [
  "reports.run",
  "metadata.read",
  "audience-exports.read",
  "audience-exports.run",
  "accounts.read",
  "properties.read",
  "access-reports.run",
  "change-history.read",
  "key-events.read",
  "custom-definitions.read",
  "data-streams.read",
  "links.read",
];

const GOOGLE_ANALYTICS_CATEGORY_ORDER = [
  "Reports",
  "Accounts",
  "Properties",
  "Admin Activity",
  "Events & Definitions",
  "Data Streams",
  "Integrations",
] as const;

export const GOOGLE_ANALYTICS_PERMISSION_MANIFEST: readonly GoogleAnalyticsManifestPermission[] =
  [
    {
      name: "reports.run",
      category: "Reports",
      description: "Run GA4 property reports and compatibility checks.",
      routeKeys: [
        "data:POST /v1beta/properties/{propertiesId}:batchRunPivotReports",
        "data:POST /v1beta/properties/{propertiesId}:batchRunReports",
        "data:POST /v1beta/properties/{propertiesId}:checkCompatibility",
        "data:POST /v1beta/properties/{propertiesId}:runPivotReport",
        "data:POST /v1beta/properties/{propertiesId}:runRealtimeReport",
        "data:POST /v1beta/properties/{propertiesId}:runReport",
      ],
    },
    {
      name: "metadata.read",
      category: "Reports",
      description: "Read GA4 property report metadata.",
      routeKeys: ["data:GET /v1beta/properties/{propertiesId}/metadata"],
    },
    {
      name: "audience-exports.read",
      category: "Reports",
      description: "Read and query GA4 audience export report jobs.",
      routeKeys: [
        "data:GET /v1beta/properties/{propertiesId}/audienceExports",
        "data:GET /v1beta/properties/{propertiesId}/audienceExports/{audienceExportsId}",
        "data:POST /v1beta/properties/{propertiesId}/audienceExports/{audienceExportsId}:query",
      ],
    },
    {
      name: "audience-exports.run",
      category: "Reports",
      description: "Create GA4 audience export report jobs.",
      routeKeys: [
        "data:POST /v1beta/properties/{propertiesId}/audienceExports",
      ],
    },
    {
      name: "accounts.read",
      category: "Accounts",
      description: "Read Google Analytics accounts and sharing settings.",
      routeKeys: [
        "admin:GET /v1beta/accountSummaries",
        "admin:GET /v1beta/accounts",
        "admin:GET /v1beta/accounts/{accountsId}",
        "admin:GET /v1beta/accounts/{accountsId}/dataSharingSettings",
      ],
    },
    {
      name: "accounts.write",
      category: "Accounts",
      description: "Create account tickets and update Analytics accounts.",
      routeKeys: [
        "admin:PATCH /v1beta/accounts/{accountsId}",
        "admin:POST /v1beta/accounts:provisionAccountTicket",
      ],
    },
    {
      name: "accounts.delete",
      category: "Accounts",
      description: "Delete Google Analytics accounts.",
      routeKeys: ["admin:DELETE /v1beta/accounts/{accountsId}"],
    },
    {
      name: "properties.read",
      category: "Properties",
      description: "Read GA4 properties and property-level settings.",
      routeKeys: [
        "admin:GET /v1beta/properties",
        "admin:GET /v1beta/properties/{propertiesId}",
        "admin:GET /v1beta/properties/{propertiesId}/dataRetentionSettings",
      ],
    },
    {
      name: "properties.write",
      category: "Properties",
      description: "Create and update GA4 properties and property settings.",
      routeKeys: [
        "admin:PATCH /v1beta/properties/{propertiesId}",
        "admin:PATCH /v1beta/properties/{propertiesId}/dataRetentionSettings",
        "admin:POST /v1beta/properties",
        "admin:POST /v1beta/properties/{propertiesId}:acknowledgeUserDataCollection",
      ],
    },
    {
      name: "properties.delete",
      category: "Properties",
      description: "Delete GA4 properties.",
      routeKeys: ["admin:DELETE /v1beta/properties/{propertiesId}"],
    },
    {
      name: "access-reports.run",
      category: "Admin Activity",
      description: "Run account and property access reports.",
      routeKeys: [
        "admin:POST /v1beta/accounts/{accountsId}:runAccessReport",
        "admin:POST /v1beta/properties/{propertiesId}:runAccessReport",
      ],
    },
    {
      name: "change-history.read",
      category: "Admin Activity",
      description: "Read account change history events.",
      routeKeys: [
        "admin:POST /v1beta/accounts/{accountsId}:searchChangeHistoryEvents",
      ],
    },
    {
      name: "key-events.read",
      category: "Events & Definitions",
      description: "Read GA4 key event and conversion event definitions.",
      routeKeys: [
        "admin:GET /v1beta/properties/{propertiesId}/conversionEvents",
        "admin:GET /v1beta/properties/{propertiesId}/conversionEvents/{conversionEventsId}",
        "admin:GET /v1beta/properties/{propertiesId}/keyEvents",
        "admin:GET /v1beta/properties/{propertiesId}/keyEvents/{keyEventsId}",
      ],
    },
    {
      name: "key-events.write",
      category: "Events & Definitions",
      description: "Create and update GA4 key event definitions.",
      routeKeys: [
        "admin:PATCH /v1beta/properties/{propertiesId}/conversionEvents/{conversionEventsId}",
        "admin:PATCH /v1beta/properties/{propertiesId}/keyEvents/{keyEventsId}",
        "admin:POST /v1beta/properties/{propertiesId}/conversionEvents",
        "admin:POST /v1beta/properties/{propertiesId}/keyEvents",
      ],
    },
    {
      name: "key-events.delete",
      category: "Events & Definitions",
      description: "Delete GA4 key event definitions.",
      routeKeys: [
        "admin:DELETE /v1beta/properties/{propertiesId}/conversionEvents/{conversionEventsId}",
        "admin:DELETE /v1beta/properties/{propertiesId}/keyEvents/{keyEventsId}",
      ],
    },
    {
      name: "custom-definitions.read",
      category: "Events & Definitions",
      description: "Read GA4 custom dimensions and metrics.",
      routeKeys: [
        "admin:GET /v1beta/properties/{propertiesId}/customDimensions",
        "admin:GET /v1beta/properties/{propertiesId}/customDimensions/{customDimensionsId}",
        "admin:GET /v1beta/properties/{propertiesId}/customMetrics",
        "admin:GET /v1beta/properties/{propertiesId}/customMetrics/{customMetricsId}",
      ],
    },
    {
      name: "custom-definitions.write",
      category: "Events & Definitions",
      description: "Create, update, and archive GA4 custom definitions.",
      routeKeys: [
        "admin:PATCH /v1beta/properties/{propertiesId}/customDimensions/{customDimensionsId}",
        "admin:PATCH /v1beta/properties/{propertiesId}/customMetrics/{customMetricsId}",
        "admin:POST /v1beta/properties/{propertiesId}/customDimensions",
        "admin:POST /v1beta/properties/{propertiesId}/customDimensions/{customDimensionsId}:archive",
        "admin:POST /v1beta/properties/{propertiesId}/customMetrics",
        "admin:POST /v1beta/properties/{propertiesId}/customMetrics/{customMetricsId}:archive",
      ],
    },
    {
      name: "data-streams.read",
      category: "Data Streams",
      description: "Read GA4 data streams.",
      routeKeys: [
        "admin:GET /v1beta/properties/{propertiesId}/dataStreams",
        "admin:GET /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}",
      ],
    },
    {
      name: "data-streams.write",
      category: "Data Streams",
      description: "Create and update GA4 data streams.",
      routeKeys: [
        "admin:PATCH /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}",
        "admin:POST /v1beta/properties/{propertiesId}/dataStreams",
      ],
    },
    {
      name: "data-streams.delete",
      category: "Data Streams",
      description: "Delete GA4 data streams.",
      routeKeys: [
        "admin:DELETE /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}",
      ],
    },
    {
      name: "measurement-secrets.read",
      category: "Data Streams",
      description: "Read GA4 Measurement Protocol secrets.",
      routeKeys: [
        "admin:GET /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}/measurementProtocolSecrets",
        "admin:GET /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}/measurementProtocolSecrets/{measurementProtocolSecretsId}",
      ],
    },
    {
      name: "measurement-secrets.write",
      category: "Data Streams",
      description: "Create and update GA4 Measurement Protocol secrets.",
      routeKeys: [
        "admin:PATCH /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}/measurementProtocolSecrets/{measurementProtocolSecretsId}",
        "admin:POST /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}/measurementProtocolSecrets",
      ],
    },
    {
      name: "measurement-secrets.delete",
      category: "Data Streams",
      description: "Delete GA4 Measurement Protocol secrets.",
      routeKeys: [
        "admin:DELETE /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}/measurementProtocolSecrets/{measurementProtocolSecretsId}",
      ],
    },
    {
      name: "links.read",
      category: "Integrations",
      description: "Read Firebase and Google Ads links.",
      routeKeys: [
        "admin:GET /v1beta/properties/{propertiesId}/firebaseLinks",
        "admin:GET /v1beta/properties/{propertiesId}/googleAdsLinks",
      ],
    },
    {
      name: "links.write",
      category: "Integrations",
      description: "Create and update Firebase and Google Ads links.",
      routeKeys: [
        "admin:PATCH /v1beta/properties/{propertiesId}/googleAdsLinks/{googleAdsLinksId}",
        "admin:POST /v1beta/properties/{propertiesId}/firebaseLinks",
        "admin:POST /v1beta/properties/{propertiesId}/googleAdsLinks",
      ],
    },
    {
      name: "links.delete",
      category: "Integrations",
      description: "Delete Firebase and Google Ads links.",
      routeKeys: [
        "admin:DELETE /v1beta/properties/{propertiesId}/firebaseLinks/{firebaseLinksId}",
        "admin:DELETE /v1beta/properties/{propertiesId}/googleAdsLinks/{googleAdsLinksId}",
      ],
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
      `Google Analytics method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  return `${httpMethod.toUpperCase()} /${methodPath.replace(/^\/+/, "")}`;
}

export function buildGoogleAnalyticsOfficialRouteKeys(
  discoveries: readonly DiscoveryEntry[],
): Set<string> {
  const routeKeys = new Set<string>();
  for (const { kind, discovery } of discoveries) {
    console.error(`  ${kind} API version: ${discovery.version ?? "unknown"}`);
    for (const method of extractMethods(discovery.resources ?? {})) {
      routeKeys.add(`${kind}:${ruleForMethod(method)}`);
    }
  }
  return routeKeys;
}

function sortedValues(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertUniquePermissionNames(
  manifest: readonly GoogleAnalyticsManifestPermission[],
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
      `Google Analytics permission manifest has duplicate permission names:\n${sortedValues(duplicates).join("\n")}`,
    );
  }
}

export function validateGoogleAnalyticsPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleAnalyticsManifestPermission[],
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
      `Unknown Google Analytics manifest route keys:\n${unknown.join("\n")}`,
    );
  }
  if (missing.length > 0) {
    messages.push(
      `Missing Google Analytics manifest route keys:\n${missing.join("\n")}`,
    );
  }
  if (duplicates.length > 0) {
    messages.push(
      `Duplicate Google Analytics manifest route assignments:\n${duplicates.join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function routeKeyParts(routeKey: string): {
  readonly kind: GoogleAnalyticsRouteKeyKind;
  readonly rule: string;
} {
  const separatorIndex = routeKey.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed Google Analytics route key: ${routeKey}`);
  }
  const kind = routeKey.slice(0, separatorIndex);
  const rule = routeKey.slice(separatorIndex + 1);
  if (kind !== "data" && kind !== "admin") {
    throw new Error(`Unknown Google Analytics route key kind: ${routeKey}`);
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE) \//.test(rule)) {
    throw new Error(`Malformed Google Analytics route rule: ${routeKey}`);
  }
  return { kind, rule };
}

function permissionsForKind(
  kind: GoogleAnalyticsRouteKeyKind,
): PermissionGroup[] {
  return GOOGLE_ANALYTICS_PERMISSION_MANIFEST.flatMap((permission) => {
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

function googleAnalyticsCategories(): Record<string, string> {
  const categories: Record<string, string> = {};
  for (const permission of GOOGLE_ANALYTICS_PERMISSION_MANIFEST) {
    categories[permission.name] = permission.category;
  }
  return categories;
}

function generateTypeScript(apis: readonly ApiEntry[]): string {
  const lines: string[] = [
    "// Auto-generated from Google's Analytics Discovery APIs and vm0's Analytics permission manifest.",
    ...GOOGLE_ANALYTICS_APIS.map((api) => {
      return `// Source: ${api.discoveryUrl}`;
    }),
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-analytics",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const googleAnalyticsFirewall = {",
    '  name: "google-analytics",',
    '  description: "Google Analytics Data and Admin APIs",',
    "  placeholders: {",
    `    GOOGLE_ANALYTICS_TOKEN: "${escapeString(GOOGLE_ANALYTICS_TOKEN_PLACEHOLDER)}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of apis) {
    lines.push("    {");
    lines.push(`      base: "${escapeString(api.base)}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      '          Authorization: "Bearer ${{ secrets.GOOGLE_ANALYTICS_TOKEN }}",',
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
      "googleAnalyticsDefaultAllowed",
      "googleAnalyticsFirewall",
      DEFAULT_ALLOWED_GOOGLE_ANALYTICS_PERMISSIONS,
    ),
  );
  lines.push(
    ...renderDefaultUnknownPolicy(
      "googleAnalyticsDefaultUnknownPolicy",
      "deny",
    ),
  );
  lines.push(
    ...renderCategories(
      "googleAnalyticsCategories",
      "googleAnalyticsFirewall",
      {
        categories: googleAnalyticsCategories(),
        displayOrder: [...GOOGLE_ANALYTICS_CATEGORY_ORDER],
      },
    ),
  );

  return lines.join("\n");
}

async function loadGoogleAnalyticsDiscoveries(): Promise<DiscoveryEntry[]> {
  const discoveries: DiscoveryEntry[] = [];
  for (const api of GOOGLE_ANALYTICS_APIS) {
    const res = await fetchSpec(
      api.discoveryUrl,
      "google-analytics discovery document",
    );
    discoveries.push({
      kind: api.kind,
      discovery: (await res.json()) as GoogleAnalyticsDiscoveryDocument,
    });
  }
  return discoveries;
}

export async function generate(): Promise<void> {
  console.error("Generating Google Analytics firewall config...");

  const discoveries = await loadGoogleAnalyticsDiscoveries();
  const officialRouteKeys = buildGoogleAnalyticsOfficialRouteKeys(discoveries);
  validateGoogleAnalyticsPermissionManifest(
    officialRouteKeys,
    GOOGLE_ANALYTICS_PERMISSION_MANIFEST,
  );

  const apis = GOOGLE_ANALYTICS_APIS.map((api): ApiEntry => {
    return {
      base: api.baseUrl,
      kind: api.kind,
      permissions: permissionsForKind(api.kind),
    };
  });

  const ts = generateTypeScript(apis);
  logStats(
    GOOGLE_ANALYTICS_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-analytics", ts, import.meta.dirname);
}
