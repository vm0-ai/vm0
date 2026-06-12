import {
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
  type PermissionGroup,
} from "./codegen";

const PLACEHOLDER_VALUE =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

export const GOOGLE_CLOUD_DISCOVERY_URLS = {
  cloudresourcemanager:
    "https://cloudresourcemanager.googleapis.com/$discovery/rest?version=v3",
  serviceusage:
    "https://serviceusage.googleapis.com/$discovery/rest?version=v1",
  iam: "https://iam.googleapis.com/$discovery/rest?version=v1",
  compute: "https://www.googleapis.com/discovery/v1/apis/compute/v1/rest",
  appengine: "https://appengine.googleapis.com/$discovery/rest?version=v1",
  sqladmin: "https://sqladmin.googleapis.com/$discovery/rest?version=v1",
  bigquery: "https://bigquery.googleapis.com/$discovery/rest?version=v2",
  storage: "https://storage.googleapis.com/$discovery/rest?version=v1",
  run: "https://run.googleapis.com/$discovery/rest?version=v2",
  cloudbuild: "https://cloudbuild.googleapis.com/$discovery/rest?version=v1",
  artifactregistry:
    "https://artifactregistry.googleapis.com/$discovery/rest?version=v1",
  container: "https://container.googleapis.com/$discovery/rest?version=v1",
  cloudfunctions:
    "https://cloudfunctions.googleapis.com/$discovery/rest?version=v2",
  secretmanager:
    "https://secretmanager.googleapis.com/$discovery/rest?version=v1",
  logging: "https://logging.googleapis.com/$discovery/rest?version=v2",
  monitoring: "https://monitoring.googleapis.com/$discovery/rest?version=v3",
  cloudbilling:
    "https://cloudbilling.googleapis.com/$discovery/rest?version=v1",
  pubsub: "https://pubsub.googleapis.com/$discovery/rest?version=v1",
  firestore: "https://firestore.googleapis.com/$discovery/rest?version=v1",
  spanner: "https://spanner.googleapis.com/$discovery/rest?version=v1",
} as const;

export const GOOGLE_CLOUD_PERMISSION_DOC_URLS = [
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/delete",
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/get",
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/insert",
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/list",
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/setMetadata",
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/setTags",
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/start",
  "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/stop",
  "https://docs.cloud.google.com/resource-manager/docs/access-control-proj",
  "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/batchEnable",
  "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/disable",
  "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/get",
  "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/list",
  "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/enable",
  "https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/get",
  "https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/list",
  "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/delete",
  "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get",
  "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert",
  "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list",
] as const;

interface DiscoveryMediaUploadProtocol {
  path?: string;
}

interface DiscoveryMethod {
  id?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
  supportsMediaUpload?: boolean;
  mediaUpload?: {
    protocols?: {
      simple?: DiscoveryMediaUploadProtocol;
      resumable?: DiscoveryMediaUploadProtocol;
    };
  };
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

interface DiscoveryDocument {
  title?: string;
  version?: string;
  baseUrl?: string;
  servicePath?: string;
  resources?: Record<string, DiscoveryResource>;
}

interface ApiConfig {
  key: keyof typeof GOOGLE_CLOUD_DISCOVERY_URLS;
  base: string;
  description: string;
}

interface PermissionMapping {
  permission: string;
  sourceUrl: (typeof GOOGLE_CLOUD_PERMISSION_DOC_URLS)[number];
  snippets: readonly string[];
}

const API_CONFIGS: ApiConfig[] = [
  {
    key: "cloudresourcemanager",
    base: "https://cloudresourcemanager.googleapis.com",
    description: "Cloud Resource Manager API",
  },
  {
    key: "serviceusage",
    base: "https://serviceusage.googleapis.com",
    description: "Service Usage API",
  },
  {
    key: "iam",
    base: "https://iam.googleapis.com",
    description: "Identity and Access Management API",
  },
  {
    key: "compute",
    base: "https://compute.googleapis.com",
    description: "Compute Engine API",
  },
  {
    key: "appengine",
    base: "https://appengine.googleapis.com",
    description: "App Engine Admin API",
  },
  {
    key: "sqladmin",
    base: "https://sqladmin.googleapis.com",
    description: "Cloud SQL Admin API",
  },
  {
    key: "bigquery",
    base: "https://bigquery.googleapis.com",
    description: "BigQuery API",
  },
  {
    key: "storage",
    base: "https://storage.googleapis.com",
    description: "Cloud Storage JSON API",
  },
  {
    key: "run",
    base: "https://run.googleapis.com",
    description: "Cloud Run Admin API",
  },
  {
    key: "cloudbuild",
    base: "https://cloudbuild.googleapis.com",
    description: "Cloud Build API",
  },
  {
    key: "artifactregistry",
    base: "https://artifactregistry.googleapis.com",
    description: "Artifact Registry API",
  },
  {
    key: "container",
    base: "https://container.googleapis.com",
    description: "Kubernetes Engine API",
  },
  {
    key: "cloudfunctions",
    base: "https://cloudfunctions.googleapis.com",
    description: "Cloud Functions API",
  },
  {
    key: "secretmanager",
    base: "https://secretmanager.googleapis.com",
    description: "Secret Manager API",
  },
  {
    key: "logging",
    base: "https://logging.googleapis.com",
    description: "Cloud Logging API",
  },
  {
    key: "monitoring",
    base: "https://monitoring.googleapis.com",
    description: "Cloud Monitoring API",
  },
  {
    key: "cloudbilling",
    base: "https://cloudbilling.googleapis.com",
    description: "Cloud Billing API",
  },
  {
    key: "pubsub",
    base: "https://pubsub.googleapis.com",
    description: "Cloud Pub/Sub API",
  },
  {
    key: "firestore",
    base: "https://firestore.googleapis.com",
    description: "Cloud Firestore API",
  },
  {
    key: "spanner",
    base: "https://spanner.googleapis.com",
    description: "Cloud Spanner API",
  },
] as const;

const RESOURCE_MANAGER_PROJECTS_SOURCE =
  "https://docs.cloud.google.com/resource-manager/docs/access-control-proj";

const PERMISSION_MAPPINGS: Record<string, PermissionMapping> = {
  "cloudresourcemanager.projects.create": {
    permission: "resourcemanager.projects.create",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.create"],
  },
  "cloudresourcemanager.projects.delete": {
    permission: "resourcemanager.projects.delete",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.delete"],
  },
  "cloudresourcemanager.projects.get": {
    permission: "resourcemanager.projects.get",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.get"],
  },
  "cloudresourcemanager.projects.getIamPolicy": {
    permission: "resourcemanager.projects.getIamPolicy",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.getIamPolicy"],
  },
  "cloudresourcemanager.projects.list": {
    permission: "resourcemanager.projects.list",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.list"],
  },
  "cloudresourcemanager.projects.patch": {
    permission: "resourcemanager.projects.update",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.update"],
  },
  "cloudresourcemanager.projects.search": {
    permission: "resourcemanager.projects.get",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: [
      "resourcemanager.projects.search",
      "resourcemanager.projects.get",
    ],
  },
  "cloudresourcemanager.projects.setIamPolicy": {
    permission: "resourcemanager.projects.setIamPolicy",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.setIamPolicy"],
  },
  "cloudresourcemanager.projects.undelete": {
    permission: "resourcemanager.projects.undelete",
    sourceUrl: RESOURCE_MANAGER_PROJECTS_SOURCE,
    snippets: ["resourcemanager.projects.undelete"],
  },
  "compute.instances.delete": {
    permission: "compute.instances.delete",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/delete",
    snippets: ["compute.instances.delete"],
  },
  "compute.instances.get": {
    permission: "compute.instances.get",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/get",
    snippets: ["compute.instances.get"],
  },
  "compute.instances.insert": {
    permission: "compute.instances.create",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/insert",
    snippets: ["compute.instances.create"],
  },
  "compute.instances.list": {
    permission: "compute.instances.list",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/list",
    snippets: ["compute.instances.list"],
  },
  "compute.instances.setMetadata": {
    permission: "compute.instances.setMetadata",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/setMetadata",
    snippets: ["compute.instances.setMetadata"],
  },
  "compute.instances.setTags": {
    permission: "compute.instances.setTags",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/setTags",
    snippets: ["compute.instances.setTags"],
  },
  "compute.instances.start": {
    permission: "compute.instances.start",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/start",
    snippets: ["compute.instances.start"],
  },
  "compute.instances.stop": {
    permission: "compute.instances.stop",
    sourceUrl:
      "https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/stop",
    snippets: ["compute.instances.stop"],
  },
  "serviceusage.services.batchEnable": {
    permission: "serviceusage.services.enable",
    sourceUrl:
      "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/batchEnable",
    snippets: ["serviceusage.services.enable"],
  },
  "serviceusage.services.disable": {
    permission: "serviceusage.services.disable",
    sourceUrl:
      "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/disable",
    snippets: ["serviceusage.services.disable"],
  },
  "serviceusage.services.enable": {
    permission: "serviceusage.services.enable",
    sourceUrl:
      "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/enable",
    snippets: ["serviceusage.services.enable"],
  },
  "serviceusage.services.get": {
    permission: "serviceusage.services.get",
    sourceUrl:
      "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/get",
    snippets: ["serviceusage.services.get"],
  },
  "serviceusage.services.list": {
    permission: "serviceusage.services.list",
    sourceUrl:
      "https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/list",
    snippets: ["serviceusage.services.list"],
  },
  "storage.buckets.get": {
    permission: "storage.buckets.get",
    sourceUrl:
      "https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/get",
    snippets: ["storage.buckets.get"],
  },
  "storage.buckets.list": {
    permission: "storage.buckets.list",
    sourceUrl:
      "https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/list",
    snippets: ["storage.buckets.list"],
  },
  "storage.objects.delete": {
    permission: "storage.objects.delete",
    sourceUrl:
      "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/delete",
    snippets: ["storage.objects.delete"],
  },
  "storage.objects.get": {
    permission: "storage.objects.get",
    sourceUrl:
      "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get",
    snippets: ["storage.objects.get"],
  },
  "storage.objects.insert": {
    permission: "storage.objects.create",
    sourceUrl:
      "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert",
    snippets: ["storage.objects.create"],
  },
  "storage.objects.list": {
    permission: "storage.objects.list",
    sourceUrl:
      "https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list",
    snippets: ["storage.objects.list"],
  },
};

const NO_PERMISSION_METHODS = new Set([
  "cloudresourcemanager.projects.testIamPermissions",
]);

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

function normalizeTemplatePath(path: string): string {
  return path
    .replace(/^\//, "")
    .replace(/\{\+([^}]+)\}/g, "{$1+}")
    .replace(/\{\*([^}]+)\}/g, "{$1*}");
}

function methodPathWithServicePath(
  discovery: DiscoveryDocument,
  methodPath: string,
): string {
  const normalized = normalizeTemplatePath(methodPath);
  const servicePath = normalizeTemplatePath(discovery.servicePath ?? "");
  if (servicePath === "") return normalized;
  if (normalized.startsWith(servicePath)) return normalized;
  if (normalized.startsWith("upload/") || normalized.startsWith("download/")) {
    return normalized;
  }
  return `${servicePath.replace(/\/$/, "")}/${normalized}`;
}

function adjustRulePath(methodId: string, path: string): string {
  if (
    methodId === "storage.objects.delete" ||
    methodId === "storage.objects.get"
  ) {
    return path.replace("/o/{object}", "/o/{object+}");
  }
  return path;
}

function rulePathsForMethod(
  discovery: DiscoveryDocument,
  method: DiscoveryMethod,
): string[] {
  if (!method.id) {
    throw new Error("Discovery method is missing id");
  }
  const paths = new Set<string>();
  const methodPath = method.flatPath ?? method.path;
  if (methodPath) {
    paths.add(
      adjustRulePath(
        method.id,
        methodPathWithServicePath(discovery, methodPath),
      ),
    );
  }

  const protocols = method.mediaUpload?.protocols;
  for (const protocol of [protocols?.simple, protocols?.resumable]) {
    if (protocol?.path) {
      paths.add(
        adjustRulePath(method.id, normalizeTemplatePath(protocol.path)),
      );
    }
  }

  return [...paths].sort();
}

function addRule(
  groups: Map<string, Set<string>>,
  permission: string,
  rule: string,
): void {
  const rules = groups.get(permission) ?? new Set<string>();
  rules.add(rule);
  groups.set(permission, rules);
}

function buildPermissionGroups(
  discovery: DiscoveryDocument,
  api: ApiConfig,
): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();

  for (const method of extractMethods(discovery.resources ?? {})) {
    if (!method.id || !method.httpMethod) {
      throw new Error(`${api.key}: Discovery method missing id or httpMethod`);
    }
    if (NO_PERMISSION_METHODS.has(method.id)) {
      continue;
    }
    const mapping = PERMISSION_MAPPINGS[method.id];
    if (!mapping) {
      // Unmapped Google Cloud methods intentionally fall through to unknownPolicy.
      // Do not invent IAM permissions when the official method-to-permission
      // mapping has not been curated here.
      continue;
    }
    for (const path of rulePathsForMethod(discovery, method)) {
      addRule(
        groups,
        mapping.permission,
        `${method.httpMethod.toUpperCase()} /${path}`,
      );
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rules]) => ({
      name,
      rules: sanitizeAndSortRules([...rules]),
    }));
}

async function validatePermissionSources(): Promise<void> {
  const mappingsBySource = new Map<string, Set<string>>();
  for (const mapping of Object.values(PERMISSION_MAPPINGS)) {
    const snippets =
      mappingsBySource.get(mapping.sourceUrl) ?? new Set<string>();
    for (const snippet of mapping.snippets) {
      snippets.add(snippet);
    }
    mappingsBySource.set(mapping.sourceUrl, snippets);
  }

  for (const [sourceUrl, snippets] of mappingsBySource) {
    const res = await fetchSpec(
      sourceUrl,
      `google-cloud permission source ${sourceUrl}`,
    );
    const text = await res.text();
    for (const snippet of snippets) {
      if (!text.includes(snippet)) {
        throw new Error(
          `Google Cloud permission source ${sourceUrl} is missing required snippet: ${snippet}`,
        );
      }
    }
  }
}

function validateMappingsWereUsed(
  mappingsSeen: Set<string>,
  apiPermissions: Map<string, PermissionGroup[]>,
): void {
  const missing = Object.keys(PERMISSION_MAPPINGS).filter((methodId) => {
    return !mappingsSeen.has(methodId);
  });
  if (missing.length > 0) {
    throw new Error(
      `Google Cloud permission mappings reference missing Discovery methods:\n${missing
        .sort()
        .map((methodId) => `  - ${methodId}`)
        .join("\n")}`,
    );
  }

  const emptyMappedApis = API_CONFIGS.filter((api) => {
    const permissions = apiPermissions.get(api.key);
    return permissions === undefined;
  });
  if (emptyMappedApis.length === API_CONFIGS.length) {
    throw new Error("Google Cloud generator produced no mapped permissions");
  }
}

function generateTypeScript(
  apiPermissions: Map<string, PermissionGroup[]>,
): string {
  const lines: string[] = [
    "// Auto-generated from Google Discovery documents and official Google Cloud IAM docs.",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-cloud",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const googleCloudFirewall = {",
    '  name: "google-cloud",',
    '  description: "Google Cloud APIs",',
    "  placeholders: {",
    `    GOOGLE_CLOUD_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of API_CONFIGS) {
    const permissions = apiPermissions.get(api.key) ?? [];
    lines.push("    {");
    lines.push(`      base: "${api.base}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      '          Authorization: "Bearer ${{ secrets.GOOGLE_CLOUD_TOKEN }}",',
    );
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

export async function generate(): Promise<void> {
  console.error("Generating Google Cloud firewall config...");
  await validatePermissionSources();

  const apiPermissions = new Map<string, PermissionGroup[]>();
  const mappingsSeen = new Set<string>();

  for (const api of API_CONFIGS) {
    const discoveryUrl = GOOGLE_CLOUD_DISCOVERY_URLS[api.key];
    const res = await fetchSpec(discoveryUrl, `${api.key} discovery document`);
    const discovery = (await res.json()) as DiscoveryDocument;
    console.error(
      `  ${api.description}: ${discovery.version ?? "unknown version"}`,
    );

    const permissions = buildPermissionGroups(discovery, api);
    for (const method of extractMethods(discovery.resources ?? {})) {
      if (method.id && PERMISSION_MAPPINGS[method.id]) {
        mappingsSeen.add(method.id);
      }
    }
    if (permissions.length > 0) {
      apiPermissions.set(api.key, permissions);
    }
  }

  validateMappingsWereUsed(mappingsSeen, apiPermissions);

  const allPermissions = [...apiPermissions.values()].flat();
  logStats(allPermissions);
  writeOutput(
    "google-cloud",
    generateTypeScript(apiPermissions),
    import.meta.dirname,
  );
}
