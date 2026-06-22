/**
 * Generate the Google Search Console firewall config.
 *
 * Google Search Console Discovery method scopes are OAuth authorization
 * constraints, not vm0 firewall permission groups. Keep route coverage
 * official by loading Search Console Discovery, but keep the firewall
 * permission taxonomy explicit here.
 */

import { fetchSpec, logStats, writeOutput } from "./codegen";
import {
  compileGoogleManifestFirewall,
  renderGoogleManifestFirewall,
  validateGoogleManifestPermissionManifest,
} from "./google-manifest";
import type { GoogleManifestPermission } from "./google-manifest";

const GOOGLE_SEARCH_CONSOLE_ROUTE_KEY_KINDS = ["base"] as const;
type GoogleSearchConsoleRouteKeyKind =
  (typeof GOOGLE_SEARCH_CONSOLE_ROUTE_KEY_KINDS)[number];

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

export interface GoogleSearchConsoleDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleSearchConsoleManifestPermission extends GoogleManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

export const GOOGLE_SEARCH_CONSOLE_DISCOVERY_URL =
  "https://searchconsole.googleapis.com/$discovery/rest?version=v1";

const GOOGLE_SEARCH_CONSOLE_BASE_URL = "https://searchconsole.googleapis.com";
const GOOGLE_SEARCH_CONSOLE_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_SEARCH_CONSOLE_PERMISSIONS = [
  "mobile-friendly-tests.run",
  "search-analytics.query",
  "sitemaps.read",
  "sites.read",
  "url-inspection.inspect",
];

const GOOGLE_SEARCH_CONSOLE_CATEGORY_ORDER = [
  "URL Inspection",
  "URL Testing",
  "Sites",
  "Search Analytics",
  "Sitemaps",
] as const;

export const GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST: readonly GoogleSearchConsoleManifestPermission[] =
  [
    {
      name: "url-inspection.inspect",
      category: "URL Inspection",
      description: "Inspect URL indexing status.",
      routeKeys: ["base:POST /v1/urlInspection/index:inspect"],
    },
    {
      name: "mobile-friendly-tests.run",
      category: "URL Testing",
      description: "Run mobile-friendly tests for URLs.",
      routeKeys: ["base:POST /v1/urlTestingTools/mobileFriendlyTest:run"],
    },
    {
      name: "sites.read",
      category: "Sites",
      description: "List and read Search Console sites.",
      routeKeys: [
        "base:GET /webmasters/v3/sites",
        "base:GET /webmasters/v3/sites/{siteUrl}",
      ],
    },
    {
      name: "sites.write",
      category: "Sites",
      description: "Add sites to Search Console.",
      routeKeys: ["base:PUT /webmasters/v3/sites/{siteUrl}"],
    },
    {
      name: "sites.delete",
      category: "Sites",
      description: "Remove sites from Search Console.",
      routeKeys: ["base:DELETE /webmasters/v3/sites/{siteUrl}"],
    },
    {
      name: "search-analytics.query",
      category: "Search Analytics",
      description: "Query Search Console search analytics data.",
      routeKeys: [
        "base:POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query",
      ],
    },
    {
      name: "sitemaps.read",
      category: "Sitemaps",
      description: "List and read submitted sitemaps.",
      routeKeys: [
        "base:GET /webmasters/v3/sites/{siteUrl}/sitemaps",
        "base:GET /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}",
      ],
    },
    {
      name: "sitemaps.write",
      category: "Sitemaps",
      description: "Submit sitemaps.",
      routeKeys: [
        "base:PUT /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}",
      ],
    },
    {
      name: "sitemaps.delete",
      category: "Sitemaps",
      description: "Delete submitted sitemaps.",
      routeKeys: [
        "base:DELETE /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}",
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
      `Google Search Console method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  const path = methodPath.startsWith("/") ? methodPath : `/${methodPath}`;
  return `${httpMethod.toUpperCase()} ${path}`;
}

export function buildGoogleSearchConsoleOfficialRouteKeys(
  discovery: GoogleSearchConsoleDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    routeKeys.add(`base:${ruleForMethod(method)}`);
  }
  return routeKeys;
}

export function validateGoogleSearchConsolePermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleSearchConsoleManifestPermission[],
): void {
  validateGoogleManifestPermissionManifest({
    serviceLabel: "Google Search Console",
    routeKinds: GOOGLE_SEARCH_CONSOLE_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest,
    categoryOrder: GOOGLE_SEARCH_CONSOLE_CATEGORY_ORDER,
  });
}

async function loadGoogleSearchConsoleDiscovery(): Promise<GoogleSearchConsoleDiscoveryDocument> {
  const res = await fetchSpec(
    GOOGLE_SEARCH_CONSOLE_DISCOVERY_URL,
    "google-search-console discovery document",
  );
  return (await res.json()) as GoogleSearchConsoleDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGoogleSearchConsoleDiscovery();
  const officialRouteKeys =
    buildGoogleSearchConsoleOfficialRouteKeys(discovery);
  const compiled = compileGoogleManifestFirewall<
    GoogleSearchConsoleRouteKeyKind,
    GoogleSearchConsoleManifestPermission
  >({
    serviceLabel: "Google Search Console",
    routeKinds: GOOGLE_SEARCH_CONSOLE_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest: GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST,
    apis: [
      {
        base: GOOGLE_SEARCH_CONSOLE_BASE_URL,
        kind: "base",
      },
    ],
    categoryOrder: GOOGLE_SEARCH_CONSOLE_CATEGORY_ORDER,
  });
  if (!compiled.categories) {
    throw new Error("Google Search Console categories were not compiled");
  }

  const ts = renderGoogleManifestFirewall({
    headerLines: [
      "// Auto-generated from Google's Search Console Discovery API and vm0's Search Console permission manifest.",
      `// Source: ${GOOGLE_SEARCH_CONSOLE_DISCOVERY_URL}`,
      "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-search-console",
      "//",
      "// DO NOT EDIT THIS FILE MANUALLY.",
    ],
    firewallVarName: "googleSearchConsoleFirewall",
    firewallName: "google-search-console",
    firewallDescription: "Google Search Console API",
    tokenPlaceholderName: "GOOGLE_SEARCH_CONSOLE_TOKEN",
    tokenPlaceholderValue: GOOGLE_SEARCH_CONSOLE_TOKEN_PLACEHOLDER,
    apis: compiled.apis,
    defaultAllowed: {
      varName: "googleSearchConsoleDefaultAllowed",
      permissions: DEFAULT_ALLOWED_GOOGLE_SEARCH_CONSOLE_PERMISSIONS,
    },
    defaultUnknownPolicy: {
      varName: "googleSearchConsoleDefaultUnknownPolicy",
      policy: "deny",
    },
    categories: {
      varName: "googleSearchConsoleCategories",
      config: compiled.categories,
    },
  });
  logStats(
    GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-search-console", ts, import.meta.dirname);
}
