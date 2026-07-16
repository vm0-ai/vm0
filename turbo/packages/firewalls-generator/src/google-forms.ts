/**
 * Generate the Google Forms firewall config from the Forms API Discovery
 * document and vm0's resource-oriented permission manifest.
 */

import { fetchSpec, logStats, writeOutput } from "./codegen";
import {
  compileGoogleManifestFirewall,
  renderGoogleManifestFirewall,
  validateGoogleManifestPermissionManifest,
} from "./google-manifest";
import type { GoogleManifestPermission } from "./google-manifest";

const GOOGLE_FORMS_ROUTE_KEY_KINDS = ["base"] as const;
type GoogleFormsRouteKeyKind = (typeof GOOGLE_FORMS_ROUTE_KEY_KINDS)[number];

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

export interface GoogleFormsDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleFormsManifestPermission extends GoogleManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

export const GOOGLE_FORMS_DISCOVERY_URL =
  "https://forms.googleapis.com/$discovery/rest?version=v1";

const GOOGLE_FORMS_BASE_URL = "https://forms.googleapis.com";
const GOOGLE_FORMS_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_FORMS_PERMISSIONS = [
  "forms.read",
  "responses.read",
  "watches.read",
];

const GOOGLE_FORMS_CATEGORY_ORDER = ["Forms", "Responses", "Watches"] as const;

export const GOOGLE_FORMS_PERMISSION_MANIFEST: readonly GoogleFormsManifestPermission[] =
  [
    {
      name: "forms.create",
      category: "Forms",
      description: "Create Google Forms.",
      routeKeys: ["base:POST /v1/forms"],
    },
    {
      name: "forms.read",
      category: "Forms",
      description: "Read Google Forms content and metadata.",
      routeKeys: ["base:GET /v1/forms/{formId}"],
    },
    {
      name: "forms.write",
      category: "Forms",
      description: "Apply batch updates to Google Forms.",
      routeKeys: ["base:POST /v1/forms/{formId}:batchUpdate"],
    },
    {
      name: "forms.publish",
      category: "Forms",
      description: "Update Google Forms publish settings.",
      routeKeys: ["base:POST /v1/forms/{formId}:setPublishSettings"],
    },
    {
      name: "responses.read",
      category: "Responses",
      description: "List and read Google Forms responses.",
      routeKeys: [
        "base:GET /v1/forms/{formId}/responses/{responseId}",
        "base:GET /v1/forms/{formId}/responses",
      ],
    },
    {
      name: "watches.create",
      category: "Watches",
      description: "Create Google Forms event watches.",
      routeKeys: ["base:POST /v1/forms/{formId}/watches"],
    },
    {
      name: "watches.read",
      category: "Watches",
      description: "List Google Forms event watches.",
      routeKeys: ["base:GET /v1/forms/{formId}/watches"],
    },
    {
      name: "watches.renew",
      category: "Watches",
      description: "Renew Google Forms event watches.",
      routeKeys: ["base:POST /v1/forms/{formId}/watches/{watchId}:renew"],
    },
    {
      name: "watches.delete",
      category: "Watches",
      description: "Delete Google Forms event watches.",
      routeKeys: ["base:DELETE /v1/forms/{formId}/watches/{watchId}"],
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
      `Google Forms method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  const path = methodPath.startsWith("/") ? methodPath : `/${methodPath}`;
  return `${httpMethod.toUpperCase()} ${path}`;
}

export function buildGoogleFormsOfficialRouteKeys(
  discovery: GoogleFormsDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    routeKeys.add(`base:${ruleForMethod(method)}`);
  }
  return routeKeys;
}

export function validateGoogleFormsPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleFormsManifestPermission[],
): void {
  validateGoogleManifestPermissionManifest({
    serviceLabel: "Google Forms",
    routeKinds: GOOGLE_FORMS_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest,
    categoryOrder: GOOGLE_FORMS_CATEGORY_ORDER,
  });
}

async function loadGoogleFormsDiscovery(): Promise<GoogleFormsDiscoveryDocument> {
  const res = await fetchSpec(
    GOOGLE_FORMS_DISCOVERY_URL,
    "google-forms discovery document",
  );
  return (await res.json()) as GoogleFormsDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGoogleFormsDiscovery();
  const officialRouteKeys = buildGoogleFormsOfficialRouteKeys(discovery);
  const compiled = compileGoogleManifestFirewall<
    GoogleFormsRouteKeyKind,
    GoogleFormsManifestPermission
  >({
    serviceLabel: "Google Forms",
    routeKinds: GOOGLE_FORMS_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest: GOOGLE_FORMS_PERMISSION_MANIFEST,
    apis: [{ base: GOOGLE_FORMS_BASE_URL, kind: "base" }],
    categoryOrder: GOOGLE_FORMS_CATEGORY_ORDER,
  });
  if (!compiled.categories) {
    throw new Error("Google Forms categories were not compiled");
  }

  const ts = renderGoogleManifestFirewall({
    headerLines: [
      "// Auto-generated from Google's Forms API Discovery document and vm0's Google Forms permission manifest.",
      `// Source: ${GOOGLE_FORMS_DISCOVERY_URL}`,
      "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-forms",
      "//",
      "// DO NOT EDIT THIS FILE MANUALLY.",
    ],
    firewallVarName: "googleFormsFirewall",
    firewallName: "google-forms",
    firewallDescription: "Google Forms API",
    tokenPlaceholderName: "GOOGLE_FORMS_TOKEN",
    tokenPlaceholderValue: GOOGLE_FORMS_TOKEN_PLACEHOLDER,
    apis: compiled.apis,
    defaultAllowed: {
      varName: "googleFormsDefaultAllowed",
      permissions: DEFAULT_ALLOWED_GOOGLE_FORMS_PERMISSIONS,
    },
    defaultUnknownPolicy: {
      varName: "googleFormsDefaultUnknownPolicy",
      policy: "deny",
    },
    categories: {
      varName: "googleFormsCategories",
      config: compiled.categories,
    },
  });
  logStats(
    GOOGLE_FORMS_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-forms", ts);
}
