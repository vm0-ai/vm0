/**
 * Generate the Google Drive firewall config.
 *
 * Google Drive Discovery method scopes are OAuth authorization constraints, not
 * vm0 firewall permission groups. Keep the route universe official by loading
 * Drive v2/v3 Discovery, but keep the permission taxonomy explicit here.
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

type GoogleDriveRouteKeyKind = "base" | "upload" | "resumable-upload";

interface DiscoveryMethod {
  id?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
  supportsMediaUpload?: boolean;
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleDriveDiscoveryDocument {
  version?: string;
  servicePath?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleDriveManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

interface ApiEntry {
  readonly base: string;
  readonly kind: GoogleDriveRouteKeyKind;
  readonly permissions: readonly PermissionGroup[];
}

export const GOOGLE_DRIVE_DISCOVERY_URLS = [
  "https://www.googleapis.com/discovery/v1/apis/drive/v2/rest",
  "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
] as const;

const GOOGLE_DRIVE_BASE_URL = "https://www.googleapis.com/drive";
const GOOGLE_DRIVE_UPLOAD_BASE_URL = "https://www.googleapis.com/upload/drive";
const GOOGLE_DRIVE_RESUMABLE_UPLOAD_BASE_URL =
  "https://www.googleapis.com/resumable/upload/drive";
const GOOGLE_DRIVE_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_DRIVE_PERMISSIONS = [
  "about.read",
  "apps.read",
  "changes.read",
  "comments.read",
  "drives.read",
  "files.read",
  "operations.read",
  "replies.read",
  "revisions.read",
];

const GOOGLE_DRIVE_CATEGORY_ORDER = [
  "Drive Metadata",
  "Files",
  "Sharing",
  "Comments",
  "Revisions",
  "Shared Drives",
  "Notifications",
] as const;

export const GOOGLE_DRIVE_PERMISSION_MANIFEST: readonly GoogleDriveManifestPermission[] =
  [
    {
      name: "about.read",
      category: "Drive Metadata",
      description: "Read Drive account and storage metadata.",
      routeKeys: ["base:GET /v2/about", "base:GET /v3/about"],
    },
    {
      name: "apps.read",
      category: "Drive Metadata",
      description: "Read Drive apps authorized for the user.",
      routeKeys: [
        "base:GET /v2/apps",
        "base:GET /v2/apps/{appId}",
        "base:GET /v3/apps",
        "base:GET /v3/apps/{appId}",
      ],
    },
    {
      name: "changes.read",
      category: "Drive Metadata",
      description: "Read Drive change logs and page tokens.",
      routeKeys: [
        "base:GET /v2/changes",
        "base:GET /v2/changes/startPageToken",
        "base:GET /v2/changes/{changeId}",
        "base:GET /v3/changes",
        "base:GET /v3/changes/startPageToken",
      ],
    },
    {
      name: "channels.write",
      category: "Notifications",
      description: "Create and stop Drive notification channels.",
      routeKeys: [
        "base:POST /v2/changes/watch",
        "base:POST /v2/channels/stop",
        "base:POST /v2/files/{fileId}/watch",
        "base:POST /v3/changes/watch",
        "base:POST /v3/channels/stop",
        "base:POST /v3/files/{fileId}/watch",
      ],
    },
    {
      name: "comments.read",
      category: "Comments",
      description: "Read Drive file comments.",
      routeKeys: [
        "base:GET /v2/files/{fileId}/comments",
        "base:GET /v2/files/{fileId}/comments/{commentId}",
        "base:GET /v3/files/{fileId}/comments",
        "base:GET /v3/files/{fileId}/comments/{commentId}",
      ],
    },
    {
      name: "comments.write",
      category: "Comments",
      description: "Create, update, and delete Drive file comments.",
      routeKeys: [
        "base:DELETE /v2/files/{fileId}/comments/{commentId}",
        "base:DELETE /v3/files/{fileId}/comments/{commentId}",
        "base:PATCH /v2/files/{fileId}/comments/{commentId}",
        "base:PATCH /v3/files/{fileId}/comments/{commentId}",
        "base:POST /v2/files/{fileId}/comments",
        "base:POST /v3/files/{fileId}/comments",
        "base:PUT /v2/files/{fileId}/comments/{commentId}",
      ],
    },
    {
      name: "replies.read",
      category: "Comments",
      description: "Read Drive comment replies.",
      routeKeys: [
        "base:GET /v2/files/{fileId}/comments/{commentId}/replies",
        "base:GET /v2/files/{fileId}/comments/{commentId}/replies/{replyId}",
        "base:GET /v3/files/{fileId}/comments/{commentId}/replies",
        "base:GET /v3/files/{fileId}/comments/{commentId}/replies/{replyId}",
      ],
    },
    {
      name: "replies.write",
      category: "Comments",
      description: "Create, update, and delete Drive comment replies.",
      routeKeys: [
        "base:DELETE /v2/files/{fileId}/comments/{commentId}/replies/{replyId}",
        "base:DELETE /v3/files/{fileId}/comments/{commentId}/replies/{replyId}",
        "base:PATCH /v2/files/{fileId}/comments/{commentId}/replies/{replyId}",
        "base:PATCH /v3/files/{fileId}/comments/{commentId}/replies/{replyId}",
        "base:POST /v2/files/{fileId}/comments/{commentId}/replies",
        "base:POST /v3/files/{fileId}/comments/{commentId}/replies",
        "base:PUT /v2/files/{fileId}/comments/{commentId}/replies/{replyId}",
      ],
    },
    {
      name: "drives.read",
      category: "Shared Drives",
      description: "Read shared drive and team drive metadata.",
      routeKeys: [
        "base:GET /v2/drives",
        "base:GET /v2/drives/{driveId}",
        "base:GET /v2/teamdrives",
        "base:GET /v2/teamdrives/{teamDriveId}",
        "base:GET /v3/drives",
        "base:GET /v3/drives/{driveId}",
        "base:GET /v3/teamdrives",
        "base:GET /v3/teamdrives/{teamDriveId}",
      ],
    },
    {
      name: "drives.write",
      category: "Shared Drives",
      description: "Create, update, hide, and unhide shared drives.",
      routeKeys: [
        "base:PATCH /v3/drives/{driveId}",
        "base:PATCH /v3/teamdrives/{teamDriveId}",
        "base:POST /v2/drives",
        "base:POST /v2/drives/{driveId}/hide",
        "base:POST /v2/drives/{driveId}/unhide",
        "base:POST /v2/teamdrives",
        "base:POST /v3/drives",
        "base:POST /v3/drives/{driveId}/hide",
        "base:POST /v3/drives/{driveId}/unhide",
        "base:POST /v3/teamdrives",
        "base:PUT /v2/drives/{driveId}",
        "base:PUT /v2/teamdrives/{teamDriveId}",
      ],
    },
    {
      name: "drives.delete",
      category: "Shared Drives",
      description: "Delete shared drives and team drives.",
      routeKeys: [
        "base:DELETE /v2/drives/{driveId}",
        "base:DELETE /v2/teamdrives/{teamDriveId}",
        "base:DELETE /v3/drives/{driveId}",
        "base:DELETE /v3/teamdrives/{teamDriveId}",
      ],
    },
    {
      name: "files.read",
      category: "Files",
      description: "Read Drive files, file metadata, labels, and content.",
      routeKeys: [
        "base:GET /v2/files",
        "base:GET /v2/files/generateCseToken",
        "base:GET /v2/files/generateIds",
        "base:GET /v2/files/{fileId}",
        "base:GET /v2/files/{fileId}/export",
        "base:GET /v2/files/{fileId}/listLabels",
        "base:GET /v2/files/{fileId}/parents",
        "base:GET /v2/files/{fileId}/parents/{parentId}",
        "base:GET /v2/files/{fileId}/properties",
        "base:GET /v2/files/{fileId}/properties/{propertyKey}",
        "base:GET /v2/files/{folderId}/children",
        "base:GET /v2/files/{folderId}/children/{childId}",
        "base:GET /v3/files",
        "base:GET /v3/files/generateCseToken",
        "base:GET /v3/files/generateIds",
        "base:GET /v3/files/{fileId}",
        "base:GET /v3/files/{fileId}/approvals",
        "base:GET /v3/files/{fileId}/approvals/{approvalId}",
        "base:GET /v3/files/{fileId}/export",
        "base:GET /v3/files/{fileId}/listLabels",
        "base:POST /v3/files/{fileId}/download",
      ],
    },
    {
      name: "files.write",
      category: "Files",
      description: "Create, update, upload, copy, organize, and label files.",
      routeKeys: [
        "base:DELETE /v2/files/{fileId}/parents/{parentId}",
        "base:DELETE /v2/files/{fileId}/properties/{propertyKey}",
        "base:DELETE /v2/files/{folderId}/children/{childId}",
        "base:PATCH /v2/files/{fileId}",
        "base:PATCH /v2/files/{fileId}/properties/{propertyKey}",
        "base:PATCH /v3/files/{fileId}",
        "base:POST /v2/files",
        "base:POST /v2/files/{fileId}/copy",
        "base:POST /v2/files/{fileId}/modifyLabels",
        "base:POST /v2/files/{fileId}/parents",
        "base:POST /v2/files/{fileId}/properties",
        "base:POST /v2/files/{fileId}/touch",
        "base:POST /v2/files/{folderId}/children",
        "base:POST /v3/files",
        "base:POST /v3/files/{fileId}/copy",
        "base:POST /v3/files/{fileId}/modifyLabels",
        "base:PUT /v2/files/{fileId}",
        "base:PUT /v2/files/{fileId}/properties/{propertyKey}",
        "resumable-upload:PATCH /v3/files/{fileId}",
        "resumable-upload:POST /v2/files",
        "resumable-upload:POST /v3/files",
        "resumable-upload:PUT /v2/files/{fileId}",
        "upload:PATCH /v3/files/{fileId}",
        "upload:POST /v2/files",
        "upload:POST /v3/files",
        "upload:PUT /v2/files/{fileId}",
      ],
    },
    {
      name: "files.delete",
      category: "Files",
      description: "Delete, trash, untrash, and empty trashed Drive files.",
      routeKeys: [
        "base:DELETE /v2/files/trash",
        "base:DELETE /v2/files/{fileId}",
        "base:DELETE /v3/files/trash",
        "base:DELETE /v3/files/{fileId}",
        "base:POST /v2/files/{fileId}/trash",
        "base:POST /v2/files/{fileId}/untrash",
      ],
    },
    {
      name: "files.share",
      category: "Sharing",
      description:
        "Read and manage Drive file permissions and access requests.",
      routeKeys: [
        "base:DELETE /v2/files/{fileId}/permissions/{permissionId}",
        "base:DELETE /v3/files/{fileId}/permissions/{permissionId}",
        "base:GET /v2/files/{fileId}/permissions",
        "base:GET /v2/files/{fileId}/permissions/{permissionId}",
        "base:GET /v2/permissionIds/{email}",
        "base:GET /v3/files/{fileId}/accessproposals",
        "base:GET /v3/files/{fileId}/accessproposals/{proposalId}",
        "base:GET /v3/files/{fileId}/permissions",
        "base:GET /v3/files/{fileId}/permissions/{permissionId}",
        "base:PATCH /v2/files/{fileId}/permissions/{permissionId}",
        "base:PATCH /v3/files/{fileId}/permissions/{permissionId}",
        "base:POST /v2/files/{fileId}/permissions",
        "base:POST /v3/files/{fileId}/accessproposals/{proposalId}:resolve",
        "base:POST /v3/files/{fileId}/permissions",
        "base:PUT /v2/files/{fileId}/permissions/{permissionId}",
      ],
    },
    {
      name: "revisions.read",
      category: "Revisions",
      description: "Read Drive file revisions.",
      routeKeys: [
        "base:GET /v2/files/{fileId}/revisions",
        "base:GET /v2/files/{fileId}/revisions/{revisionId}",
        "base:GET /v3/files/{fileId}/revisions",
        "base:GET /v3/files/{fileId}/revisions/{revisionId}",
      ],
    },
    {
      name: "revisions.write",
      category: "Revisions",
      description: "Update Drive file revisions.",
      routeKeys: [
        "base:PATCH /v2/files/{fileId}/revisions/{revisionId}",
        "base:PATCH /v3/files/{fileId}/revisions/{revisionId}",
        "base:PUT /v2/files/{fileId}/revisions/{revisionId}",
      ],
    },
    {
      name: "revisions.delete",
      category: "Revisions",
      description: "Delete Drive file revisions.",
      routeKeys: [
        "base:DELETE /v2/files/{fileId}/revisions/{revisionId}",
        "base:DELETE /v3/files/{fileId}/revisions/{revisionId}",
      ],
    },
    {
      name: "operations.read",
      category: "Drive Metadata",
      description: "Read long-running Drive operations.",
      routeKeys: ["base:GET /v3/operations/{name}"],
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

function versionPrefix(discovery: GoogleDriveDiscoveryDocument): string {
  const servicePath = discovery.servicePath ?? "";
  if (!servicePath) return "";
  const parts = servicePath.replace(/\/$/, "").split("/");
  const lastPart = parts.at(-1);
  return parts.length > 1 && lastPart ? `${lastPart}/` : "";
}

function baseRuleForMethod(
  discovery: GoogleDriveDiscoveryDocument,
  method: DiscoveryMethod,
): string {
  const httpMethod = method.httpMethod;
  const methodPath = method.flatPath ?? method.path;
  if (!httpMethod || !methodPath) {
    throw new Error(
      `Google Drive method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  return `${httpMethod.toUpperCase()} /${versionPrefix(discovery)}${methodPath}`;
}

export function buildGoogleDriveOfficialRouteKeys(
  discoveries: readonly GoogleDriveDiscoveryDocument[],
): Set<string> {
  const routeKeys = new Set<string>();
  let hasUploadMethods = false;
  for (const discovery of discoveries) {
    console.error(`  API version: ${discovery.version ?? "unknown"}`);
    for (const method of extractMethods(discovery.resources ?? {})) {
      const rule = baseRuleForMethod(discovery, method);
      routeKeys.add(`base:${rule}`);
      if (method.supportsMediaUpload) {
        hasUploadMethods = true;
        routeKeys.add(`upload:${rule}`);
        routeKeys.add(`resumable-upload:${rule}`);
      }
    }
  }
  if (!hasUploadMethods) {
    throw new Error("Google Drive Discovery reports no upload methods");
  }
  return routeKeys;
}

function sortedValues(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertUniquePermissionNames(
  manifest: readonly GoogleDriveManifestPermission[],
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
      `Google Drive permission manifest has duplicate permission names:\n${sortedValues(duplicates).join("\n")}`,
    );
  }
}

export function validateGoogleDrivePermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleDriveManifestPermission[],
  duplicateRouteAllowlist: ReadonlySet<string> = new Set<string>(),
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
      .filter(([routeKey, permissions]) => {
        return permissions.length > 1 && !duplicateRouteAllowlist.has(routeKey);
      })
      .map(([routeKey, permissions]) => {
        return `${routeKey} -> ${permissions.join(", ")}`;
      }),
  );

  const messages: string[] = [];
  if (unknown.length > 0) {
    messages.push(
      `Unknown Google Drive manifest route keys:\n${unknown.join("\n")}`,
    );
  }
  if (missing.length > 0) {
    messages.push(
      `Missing Google Drive manifest route keys:\n${missing.join("\n")}`,
    );
  }
  if (duplicates.length > 0) {
    messages.push(
      `Duplicate Google Drive manifest route assignments:\n${duplicates.join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function routeKeyParts(routeKey: string): {
  readonly kind: GoogleDriveRouteKeyKind;
  readonly rule: string;
} {
  const separatorIndex = routeKey.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed Google Drive route key: ${routeKey}`);
  }
  const kind = routeKey.slice(0, separatorIndex);
  const rule = routeKey.slice(separatorIndex + 1);
  if (kind !== "base" && kind !== "upload" && kind !== "resumable-upload") {
    throw new Error(`Unknown Google Drive route key kind: ${routeKey}`);
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE) \//.test(rule)) {
    throw new Error(`Malformed Google Drive route rule: ${routeKey}`);
  }
  return { kind, rule };
}

function permissionsForKind(kind: GoogleDriveRouteKeyKind): PermissionGroup[] {
  return GOOGLE_DRIVE_PERMISSION_MANIFEST.flatMap((permission) => {
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

function googleDriveCategories(): Record<string, string> {
  const categories: Record<string, string> = {};
  for (const permission of GOOGLE_DRIVE_PERMISSION_MANIFEST) {
    categories[permission.name] = permission.category;
  }
  return categories;
}

function generateTypeScript(apis: readonly ApiEntry[]): string {
  const lines: string[] = [
    "// Auto-generated from Google's Drive Discovery API and vm0's Drive permission manifest.",
    ...GOOGLE_DRIVE_DISCOVERY_URLS.map((url) => {
      return `// Source: ${url}`;
    }),
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-drive",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const googleDriveFirewall = {",
    '  name: "google-drive",',
    '  description: "Google Drive API",',
    "  placeholders: {",
    `    GOOGLE_DRIVE_TOKEN: "${escapeString(GOOGLE_DRIVE_TOKEN_PLACEHOLDER)}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of apis) {
    lines.push("    {");
    lines.push(`      base: "${api.base}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      '          Authorization: "Bearer ${{ secrets.GOOGLE_DRIVE_TOKEN }}",',
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
      "googleDriveDefaultAllowed",
      "googleDriveFirewall",
      DEFAULT_ALLOWED_GOOGLE_DRIVE_PERMISSIONS,
    ),
  );
  lines.push(
    ...renderDefaultUnknownPolicy("googleDriveDefaultUnknownPolicy", "deny"),
  );
  lines.push(
    ...renderCategories("googleDriveCategories", "googleDriveFirewall", {
      categories: googleDriveCategories(),
      displayOrder: [...GOOGLE_DRIVE_CATEGORY_ORDER],
    }),
  );

  return lines.join("\n");
}

async function loadGoogleDriveDiscoveries(): Promise<
  GoogleDriveDiscoveryDocument[]
> {
  const discoveries: GoogleDriveDiscoveryDocument[] = [];
  for (const discoveryUrl of GOOGLE_DRIVE_DISCOVERY_URLS) {
    const res = await fetchSpec(
      discoveryUrl,
      "google-drive discovery document",
    );
    discoveries.push((await res.json()) as GoogleDriveDiscoveryDocument);
  }
  return discoveries;
}

export async function generate(): Promise<void> {
  const discoveries = await loadGoogleDriveDiscoveries();
  const officialRouteKeys = buildGoogleDriveOfficialRouteKeys(discoveries);
  validateGoogleDrivePermissionManifest(
    officialRouteKeys,
    GOOGLE_DRIVE_PERMISSION_MANIFEST,
  );

  const apis: ApiEntry[] = [
    {
      base: GOOGLE_DRIVE_BASE_URL,
      kind: "base",
      permissions: permissionsForKind("base"),
    },
    {
      base: GOOGLE_DRIVE_UPLOAD_BASE_URL,
      kind: "upload",
      permissions: permissionsForKind("upload"),
    },
    {
      base: GOOGLE_DRIVE_RESUMABLE_UPLOAD_BASE_URL,
      kind: "resumable-upload",
      permissions: permissionsForKind("resumable-upload"),
    },
  ];

  const ts = generateTypeScript(apis);
  logStats(
    GOOGLE_DRIVE_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-drive", ts, import.meta.dirname);
}
