/**
 * Generate the Google Contacts firewall config from the People API Discovery
 * document and vm0's resource-oriented permission manifest.
 */

import { fetchSpec, logStats, writeOutput } from "./codegen";
import {
  compileGoogleManifestFirewall,
  renderGoogleManifestFirewall,
  validateGoogleManifestPermissionManifest,
} from "./google-manifest";
import type { GoogleManifestPermission } from "./google-manifest";

const GOOGLE_CONTACTS_ROUTE_KEY_KINDS = ["base"] as const;
type GoogleContactsRouteKeyKind =
  (typeof GOOGLE_CONTACTS_ROUTE_KEY_KINDS)[number];

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

export interface GoogleContactsDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleContactsManifestPermission extends GoogleManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

export const GOOGLE_CONTACTS_DISCOVERY_URL =
  "https://people.googleapis.com/$discovery/rest?version=v1";

const GOOGLE_CONTACTS_BASE_URL = "https://people.googleapis.com";
const GOOGLE_CONTACTS_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_CONTACTS_PERMISSIONS = [
  "contact-groups.read",
  "contacts.read",
];

const GOOGLE_CONTACTS_CATEGORY_ORDER = [
  "Contacts",
  "Contact Groups",
  "Other Contacts",
  "Directory",
] as const;

export const GOOGLE_CONTACTS_PERMISSION_MANIFEST: readonly GoogleContactsManifestPermission[] =
  [
    {
      name: "contacts.read",
      category: "Contacts",
      description: "Read and search Google contacts.",
      routeKeys: [
        "base:GET /v1/people/{peopleId}",
        "base:GET /v1/people:batchGet",
        "base:GET /v1/people/{peopleId}/connections",
        "base:GET /v1/people:searchContacts",
      ],
    },
    {
      name: "contacts.create",
      category: "Contacts",
      description: "Create Google contacts individually or in batches.",
      routeKeys: [
        "base:POST /v1/people:createContact",
        "base:POST /v1/people:batchCreateContacts",
      ],
    },
    {
      name: "contacts.update",
      category: "Contacts",
      description: "Update Google contacts individually or in batches.",
      routeKeys: [
        "base:PATCH /v1/people/{peopleId}:updateContact",
        "base:POST /v1/people:batchUpdateContacts",
      ],
    },
    {
      name: "contacts.delete",
      category: "Contacts",
      description: "Delete Google contacts individually or in batches.",
      routeKeys: [
        "base:DELETE /v1/people/{peopleId}:deleteContact",
        "base:POST /v1/people:batchDeleteContacts",
      ],
    },
    {
      name: "contact-photos.write",
      category: "Contacts",
      description: "Update or delete Google contact photos.",
      routeKeys: [
        "base:DELETE /v1/people/{peopleId}:deleteContactPhoto",
        "base:PATCH /v1/people/{peopleId}:updateContactPhoto",
      ],
    },
    {
      name: "contact-groups.read",
      category: "Contact Groups",
      description: "Read Google contact groups.",
      routeKeys: [
        "base:GET /v1/contactGroups:batchGet",
        "base:GET /v1/contactGroups/{contactGroupsId}",
        "base:GET /v1/contactGroups",
      ],
    },
    {
      name: "contact-groups.create",
      category: "Contact Groups",
      description: "Create Google contact groups.",
      routeKeys: ["base:POST /v1/contactGroups"],
    },
    {
      name: "contact-groups.update",
      category: "Contact Groups",
      description: "Update Google contact groups and their memberships.",
      routeKeys: [
        "base:POST /v1/contactGroups/{contactGroupsId}/members:modify",
        "base:PUT /v1/contactGroups/{contactGroupsId}",
      ],
    },
    {
      name: "contact-groups.delete",
      category: "Contact Groups",
      description: "Delete Google contact groups.",
      routeKeys: ["base:DELETE /v1/contactGroups/{contactGroupsId}"],
    },
    {
      name: "other-contacts.read",
      category: "Other Contacts",
      description: "Read and search Google other contacts.",
      routeKeys: [
        "base:GET /v1/otherContacts",
        "base:GET /v1/otherContacts:search",
      ],
    },
    {
      name: "other-contacts.copy",
      category: "Other Contacts",
      description: "Copy an other contact into My Contacts.",
      routeKeys: [
        "base:POST /v1/otherContacts/{otherContactsId}:copyOtherContactToMyContactsGroup",
      ],
    },
    {
      name: "directory.read",
      category: "Directory",
      description: "List and search Google Workspace directory people.",
      routeKeys: [
        "base:GET /v1/people:listDirectoryPeople",
        "base:GET /v1/people:searchDirectoryPeople",
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
      `Google Contacts method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  const path = methodPath.startsWith("/") ? methodPath : `/${methodPath}`;
  return `${httpMethod.toUpperCase()} ${path}`;
}

export function buildGoogleContactsOfficialRouteKeys(
  discovery: GoogleContactsDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    routeKeys.add(`base:${ruleForMethod(method)}`);
  }
  return routeKeys;
}

export function validateGoogleContactsPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleContactsManifestPermission[],
): void {
  validateGoogleManifestPermissionManifest({
    serviceLabel: "Google Contacts",
    routeKinds: GOOGLE_CONTACTS_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest,
    categoryOrder: GOOGLE_CONTACTS_CATEGORY_ORDER,
  });
}

async function loadGoogleContactsDiscovery(): Promise<GoogleContactsDiscoveryDocument> {
  const res = await fetchSpec(
    GOOGLE_CONTACTS_DISCOVERY_URL,
    "google-contacts discovery document",
  );
  return (await res.json()) as GoogleContactsDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGoogleContactsDiscovery();
  const officialRouteKeys = buildGoogleContactsOfficialRouteKeys(discovery);
  const compiled = compileGoogleManifestFirewall<
    GoogleContactsRouteKeyKind,
    GoogleContactsManifestPermission
  >({
    serviceLabel: "Google Contacts",
    routeKinds: GOOGLE_CONTACTS_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest: GOOGLE_CONTACTS_PERMISSION_MANIFEST,
    apis: [{ base: GOOGLE_CONTACTS_BASE_URL, kind: "base" }],
    categoryOrder: GOOGLE_CONTACTS_CATEGORY_ORDER,
  });
  if (!compiled.categories) {
    throw new Error("Google Contacts categories were not compiled");
  }

  const ts = renderGoogleManifestFirewall({
    headerLines: [
      "// Auto-generated from Google's People API Discovery document and vm0's Google Contacts permission manifest.",
      `// Source: ${GOOGLE_CONTACTS_DISCOVERY_URL}`,
      "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-contacts",
      "//",
      "// DO NOT EDIT THIS FILE MANUALLY.",
    ],
    firewallVarName: "googleContactsFirewall",
    firewallName: "google-contacts",
    firewallDescription: "Google People API for Google Contacts",
    tokenPlaceholderName: "GOOGLE_CONTACTS_TOKEN",
    tokenPlaceholderValue: GOOGLE_CONTACTS_TOKEN_PLACEHOLDER,
    apis: compiled.apis,
    defaultAllowed: {
      varName: "googleContactsDefaultAllowed",
      permissions: DEFAULT_ALLOWED_GOOGLE_CONTACTS_PERMISSIONS,
    },
    defaultUnknownPolicy: {
      varName: "googleContactsDefaultUnknownPolicy",
      policy: "deny",
    },
    categories: {
      varName: "googleContactsCategories",
      config: compiled.categories,
    },
  });
  logStats(
    GOOGLE_CONTACTS_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-contacts", ts);
}
