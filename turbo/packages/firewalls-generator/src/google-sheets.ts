/**
 * Generate the Google Sheets firewall config.
 *
 * Google Sheets Discovery method scopes are OAuth authorization constraints,
 * not vm0 firewall permission groups. Keep route coverage official by loading
 * Sheets v4 Discovery, but keep the firewall permission taxonomy explicit here.
 */

import { fetchSpec, logStats, writeOutput } from "./codegen";
import {
  compileGoogleManifestFirewall,
  renderGoogleManifestFirewall,
  validateGoogleManifestPermissionManifest,
} from "./google-manifest";
import type { GoogleManifestPermission } from "./google-manifest";

const GOOGLE_SHEETS_ROUTE_KEY_KINDS = ["base"] as const;
type GoogleSheetsRouteKeyKind = (typeof GOOGLE_SHEETS_ROUTE_KEY_KINDS)[number];

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

export interface GoogleSheetsDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleSheetsManifestPermission extends GoogleManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

export const GOOGLE_SHEETS_DISCOVERY_URL =
  "https://sheets.googleapis.com/$discovery/rest?version=v4";

const GOOGLE_SHEETS_BASE_URL = "https://sheets.googleapis.com";
const GOOGLE_SHEETS_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_SHEETS_PERMISSIONS = [
  "developer-metadata.read",
  "developer-metadata.search",
  "spreadsheets.read",
  "spreadsheets.read-by-data-filter",
  "values.read",
  "values.read-by-data-filter",
];

const GOOGLE_SHEETS_CATEGORY_ORDER = [
  "Spreadsheets",
  "Values",
  "Developer Metadata",
  "Sheets",
] as const;

export const GOOGLE_SHEETS_PERMISSION_MANIFEST: readonly GoogleSheetsManifestPermission[] =
  [
    {
      name: "spreadsheets.create",
      category: "Spreadsheets",
      description: "Create Google Sheets spreadsheets.",
      routeKeys: ["base:POST /v4/spreadsheets"],
    },
    {
      name: "spreadsheets.read",
      category: "Spreadsheets",
      description: "Read Google Sheets spreadsheet metadata and grid data.",
      routeKeys: ["base:GET /v4/spreadsheets/{spreadsheetId}"],
    },
    {
      name: "spreadsheets.read-by-data-filter",
      category: "Spreadsheets",
      description: "Read Google Sheets spreadsheets by data filter.",
      routeKeys: ["base:POST /v4/spreadsheets/{spreadsheetId}:getByDataFilter"],
    },
    {
      name: "spreadsheets.write",
      category: "Spreadsheets",
      description: "Apply batch updates to Google Sheets spreadsheets.",
      routeKeys: ["base:POST /v4/spreadsheets/{spreadsheetId}:batchUpdate"],
    },
    {
      name: "values.read",
      category: "Values",
      description: "Read Google Sheets cell values.",
      routeKeys: [
        "base:GET /v4/spreadsheets/{spreadsheetId}/values/{range}",
        "base:GET /v4/spreadsheets/{spreadsheetId}/values:batchGet",
      ],
    },
    {
      name: "values.read-by-data-filter",
      category: "Values",
      description: "Read Google Sheets cell values by data filter.",
      routeKeys: [
        "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchGetByDataFilter",
      ],
    },
    {
      name: "values.write",
      category: "Values",
      description: "Append and update Google Sheets cell values.",
      routeKeys: [
        "base:POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append",
        "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdate",
        "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdateByDataFilter",
        "base:PUT /v4/spreadsheets/{spreadsheetId}/values/{range}",
      ],
    },
    {
      name: "values.clear",
      category: "Values",
      description: "Clear Google Sheets cell values.",
      routeKeys: [
        "base:POST /v4/spreadsheets/{spreadsheetId}/values/{range}:clear",
        "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchClear",
        "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchClearByDataFilter",
      ],
    },
    {
      name: "developer-metadata.read",
      category: "Developer Metadata",
      description: "Read Google Sheets developer metadata.",
      routeKeys: [
        "base:GET /v4/spreadsheets/{spreadsheetId}/developerMetadata/{metadataId}",
      ],
    },
    {
      name: "developer-metadata.search",
      category: "Developer Metadata",
      description: "Search Google Sheets developer metadata.",
      routeKeys: [
        "base:POST /v4/spreadsheets/{spreadsheetId}/developerMetadata:search",
      ],
    },
    {
      name: "sheets.copy",
      category: "Sheets",
      description: "Copy sheets between Google Sheets spreadsheets.",
      routeKeys: [
        "base:POST /v4/spreadsheets/{spreadsheetId}/sheets/{sheetId}:copyTo",
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
      `Google Sheets method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  const path = methodPath.startsWith("/") ? methodPath : `/${methodPath}`;
  return `${httpMethod.toUpperCase()} ${path}`;
}

export function buildGoogleSheetsOfficialRouteKeys(
  discovery: GoogleSheetsDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    routeKeys.add(`base:${ruleForMethod(method)}`);
  }
  return routeKeys;
}

export function validateGoogleSheetsPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleSheetsManifestPermission[],
): void {
  validateGoogleManifestPermissionManifest({
    serviceLabel: "Google Sheets",
    routeKinds: GOOGLE_SHEETS_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest,
    categoryOrder: GOOGLE_SHEETS_CATEGORY_ORDER,
  });
}

async function loadGoogleSheetsDiscovery(): Promise<GoogleSheetsDiscoveryDocument> {
  const res = await fetchSpec(
    GOOGLE_SHEETS_DISCOVERY_URL,
    "google-sheets discovery document",
  );
  return (await res.json()) as GoogleSheetsDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGoogleSheetsDiscovery();
  const officialRouteKeys = buildGoogleSheetsOfficialRouteKeys(discovery);
  const compiled = compileGoogleManifestFirewall<
    GoogleSheetsRouteKeyKind,
    GoogleSheetsManifestPermission
  >({
    serviceLabel: "Google Sheets",
    routeKinds: GOOGLE_SHEETS_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest: GOOGLE_SHEETS_PERMISSION_MANIFEST,
    apis: [
      {
        base: GOOGLE_SHEETS_BASE_URL,
        kind: "base",
      },
    ],
    categoryOrder: GOOGLE_SHEETS_CATEGORY_ORDER,
  });
  if (!compiled.categories) {
    throw new Error("Google Sheets categories were not compiled");
  }

  const ts = renderGoogleManifestFirewall({
    headerLines: [
      "// Auto-generated from Google's Sheets Discovery API and vm0's Sheets permission manifest.",
      `// Source: ${GOOGLE_SHEETS_DISCOVERY_URL}`,
      "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-sheets",
      "//",
      "// DO NOT EDIT THIS FILE MANUALLY.",
    ],
    firewallVarName: "googleSheetsFirewall",
    firewallName: "google-sheets",
    firewallDescription: "Google Sheets API",
    tokenPlaceholderName: "GOOGLE_SHEETS_TOKEN",
    tokenPlaceholderValue: GOOGLE_SHEETS_TOKEN_PLACEHOLDER,
    apis: compiled.apis,
    defaultAllowed: {
      varName: "googleSheetsDefaultAllowed",
      permissions: DEFAULT_ALLOWED_GOOGLE_SHEETS_PERMISSIONS,
    },
    defaultUnknownPolicy: {
      varName: "googleSheetsDefaultUnknownPolicy",
      policy: "deny",
    },
    categories: {
      varName: "googleSheetsCategories",
      config: compiled.categories,
    },
  });
  logStats(
    GOOGLE_SHEETS_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-sheets", ts, import.meta.dirname);
}
