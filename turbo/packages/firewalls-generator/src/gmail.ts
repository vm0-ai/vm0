/**
 * Generate the Gmail firewall config.
 *
 * Gmail Discovery method scopes are OAuth authorization constraints, not vm0
 * firewall permission groups. Keep route coverage official by loading Gmail
 * Discovery, but keep the firewall permission taxonomy explicit here.
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

type GmailRouteKeyKind = "base" | "upload" | "resumable-upload";

interface DiscoveryMethod {
  id?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
  supportsMediaUpload?: boolean;
  mediaUpload?: {
    protocols?: {
      simple?: { path?: string };
      resumable?: { path?: string };
    };
  };
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface GmailDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GmailManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

interface ApiEntry {
  readonly base: string;
  readonly kind: GmailRouteKeyKind;
  readonly permissions: readonly PermissionGroup[];
}

export const GMAIL_DISCOVERY_URL =
  "https://gmail.googleapis.com/$discovery/rest?version=v1";

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail";
const GMAIL_UPLOAD_BASE_URL = "https://gmail.googleapis.com/upload/gmail";
const GMAIL_RESUMABLE_UPLOAD_BASE_URL =
  "https://gmail.googleapis.com/resumable/upload/gmail";
const GMAIL_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GMAIL_PERMISSIONS = [
  "drafts.read",
  "drafts.write",
  "history.read",
  "labels.read",
  "messages.read",
  "profile.read",
  "settings.read",
  "threads.read",
];

const GMAIL_CATEGORY_ORDER = [
  "Mailbox",
  "Messages",
  "Drafts",
  "Threads",
  "Labels",
  "Settings",
  "Notifications",
] as const;

export const GMAIL_PERMISSION_MANIFEST: readonly GmailManifestPermission[] = [
  {
    name: "profile.read",
    category: "Mailbox",
    description: "Read the Gmail profile and mailbox email address.",
    routeKeys: ["base:GET /v1/users/{userId}/profile"],
  },
  {
    name: "history.read",
    category: "Mailbox",
    description: "Read Gmail mailbox history changes.",
    routeKeys: ["base:GET /v1/users/{userId}/history"],
  },
  {
    name: "drafts.read",
    category: "Drafts",
    description: "Read Gmail drafts.",
    routeKeys: [
      "base:GET /v1/users/{userId}/drafts",
      "base:GET /v1/users/{userId}/drafts/{id}",
    ],
  },
  {
    name: "drafts.write",
    category: "Drafts",
    description: "Create, update, and delete Gmail drafts.",
    routeKeys: [
      "base:DELETE /v1/users/{userId}/drafts/{id}",
      "base:POST /v1/users/{userId}/drafts",
      "base:PUT /v1/users/{userId}/drafts/{id}",
      "resumable-upload:POST /v1/users/{userId}/drafts",
      "resumable-upload:PUT /v1/users/{userId}/drafts/{id}",
      "upload:POST /v1/users/{userId}/drafts",
      "upload:PUT /v1/users/{userId}/drafts/{id}",
    ],
  },
  {
    name: "drafts.send",
    category: "Drafts",
    description: "Send Gmail drafts.",
    routeKeys: [
      "base:POST /v1/users/{userId}/drafts/send",
      "resumable-upload:POST /v1/users/{userId}/drafts/send",
      "upload:POST /v1/users/{userId}/drafts/send",
    ],
  },
  {
    name: "labels.read",
    category: "Labels",
    description: "Read Gmail labels.",
    routeKeys: [
      "base:GET /v1/users/{userId}/labels",
      "base:GET /v1/users/{userId}/labels/{id}",
    ],
  },
  {
    name: "labels.write",
    category: "Labels",
    description: "Create, update, and delete Gmail labels.",
    routeKeys: [
      "base:DELETE /v1/users/{userId}/labels/{id}",
      "base:PATCH /v1/users/{userId}/labels/{id}",
      "base:POST /v1/users/{userId}/labels",
      "base:PUT /v1/users/{userId}/labels/{id}",
    ],
  },
  {
    name: "messages.read",
    category: "Messages",
    description: "Read Gmail messages, message metadata, and attachments.",
    routeKeys: [
      "base:GET /v1/users/{userId}/messages",
      "base:GET /v1/users/{userId}/messages/{id}",
      "base:GET /v1/users/{userId}/messages/{messageId}/attachments/{id}",
    ],
  },
  {
    name: "messages.write",
    category: "Messages",
    description: "Import, insert, label, trash, and untrash Gmail messages.",
    routeKeys: [
      "base:POST /v1/users/{userId}/messages",
      "base:POST /v1/users/{userId}/messages/batchModify",
      "base:POST /v1/users/{userId}/messages/import",
      "base:POST /v1/users/{userId}/messages/{id}/modify",
      "base:POST /v1/users/{userId}/messages/{id}/trash",
      "base:POST /v1/users/{userId}/messages/{id}/untrash",
      "resumable-upload:POST /v1/users/{userId}/messages",
      "resumable-upload:POST /v1/users/{userId}/messages/import",
      "upload:POST /v1/users/{userId}/messages",
      "upload:POST /v1/users/{userId}/messages/import",
    ],
  },
  {
    name: "messages.send",
    category: "Messages",
    description: "Send Gmail messages directly.",
    routeKeys: [
      "base:POST /v1/users/{userId}/messages/send",
      "resumable-upload:POST /v1/users/{userId}/messages/send",
      "upload:POST /v1/users/{userId}/messages/send",
    ],
  },
  {
    name: "messages.delete",
    category: "Messages",
    description: "Permanently delete Gmail messages.",
    routeKeys: [
      "base:DELETE /v1/users/{userId}/messages/{id}",
      "base:POST /v1/users/{userId}/messages/batchDelete",
    ],
  },
  {
    name: "threads.read",
    category: "Threads",
    description: "Read Gmail threads.",
    routeKeys: [
      "base:GET /v1/users/{userId}/threads",
      "base:GET /v1/users/{userId}/threads/{id}",
    ],
  },
  {
    name: "threads.write",
    category: "Threads",
    description: "Modify, trash, and untrash Gmail threads.",
    routeKeys: [
      "base:POST /v1/users/{userId}/threads/{id}/modify",
      "base:POST /v1/users/{userId}/threads/{id}/trash",
      "base:POST /v1/users/{userId}/threads/{id}/untrash",
    ],
  },
  {
    name: "threads.delete",
    category: "Threads",
    description: "Permanently delete Gmail threads.",
    routeKeys: ["base:DELETE /v1/users/{userId}/threads/{id}"],
  },
  {
    name: "settings.read",
    category: "Settings",
    description: "Read Gmail mailbox settings.",
    routeKeys: [
      "base:GET /v1/users/{userId}/settings/autoForwarding",
      "base:GET /v1/users/{userId}/settings/cse/identities",
      "base:GET /v1/users/{userId}/settings/cse/identities/{cseEmailAddress}",
      "base:GET /v1/users/{userId}/settings/cse/keypairs",
      "base:GET /v1/users/{userId}/settings/cse/keypairs/{keyPairId}",
      "base:GET /v1/users/{userId}/settings/delegates",
      "base:GET /v1/users/{userId}/settings/delegates/{delegateEmail}",
      "base:GET /v1/users/{userId}/settings/filters",
      "base:GET /v1/users/{userId}/settings/filters/{id}",
      "base:GET /v1/users/{userId}/settings/forwardingAddresses",
      "base:GET /v1/users/{userId}/settings/forwardingAddresses/{forwardingEmail}",
      "base:GET /v1/users/{userId}/settings/imap",
      "base:GET /v1/users/{userId}/settings/language",
      "base:GET /v1/users/{userId}/settings/pop",
      "base:GET /v1/users/{userId}/settings/sendAs",
      "base:GET /v1/users/{userId}/settings/sendAs/{sendAsEmail}",
      "base:GET /v1/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo",
      "base:GET /v1/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo/{id}",
      "base:GET /v1/users/{userId}/settings/vacation",
    ],
  },
  {
    name: "settings.write",
    category: "Settings",
    description: "Create, update, and delete ordinary Gmail settings.",
    routeKeys: [
      "base:DELETE /v1/users/{userId}/settings/cse/identities/{cseEmailAddress}",
      "base:DELETE /v1/users/{userId}/settings/filters/{id}",
      "base:DELETE /v1/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo/{id}",
      "base:PATCH /v1/users/{userId}/settings/cse/identities/{emailAddress}",
      "base:PATCH /v1/users/{userId}/settings/sendAs/{sendAsEmail}",
      "base:POST /v1/users/{userId}/settings/cse/identities",
      "base:POST /v1/users/{userId}/settings/cse/keypairs",
      "base:POST /v1/users/{userId}/settings/cse/keypairs/{keyPairId}:disable",
      "base:POST /v1/users/{userId}/settings/cse/keypairs/{keyPairId}:enable",
      "base:POST /v1/users/{userId}/settings/cse/keypairs/{keyPairId}:obliterate",
      "base:POST /v1/users/{userId}/settings/filters",
      "base:POST /v1/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo",
      "base:POST /v1/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault",
      "base:PUT /v1/users/{userId}/settings/imap",
      "base:PUT /v1/users/{userId}/settings/language",
      "base:PUT /v1/users/{userId}/settings/pop",
      "base:PUT /v1/users/{userId}/settings/sendAs/{sendAsEmail}",
      "base:PUT /v1/users/{userId}/settings/vacation",
    ],
  },
  {
    name: "settings.sharing",
    category: "Settings",
    description:
      "Manage Gmail forwarding, delegates, sending identities, and sharing-sensitive settings.",
    routeKeys: [
      "base:DELETE /v1/users/{userId}/settings/delegates/{delegateEmail}",
      "base:DELETE /v1/users/{userId}/settings/forwardingAddresses/{forwardingEmail}",
      "base:DELETE /v1/users/{userId}/settings/sendAs/{sendAsEmail}",
      "base:POST /v1/users/{userId}/settings/delegates",
      "base:POST /v1/users/{userId}/settings/forwardingAddresses",
      "base:POST /v1/users/{userId}/settings/sendAs",
      "base:POST /v1/users/{userId}/settings/sendAs/{sendAsEmail}/verify",
      "base:PUT /v1/users/{userId}/settings/autoForwarding",
    ],
  },
  {
    name: "notifications.write",
    category: "Notifications",
    description: "Create and stop Gmail mailbox notification watches.",
    routeKeys: [
      "base:POST /v1/users/{userId}/stop",
      "base:POST /v1/users/{userId}/watch",
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

function baseRuleForMethod(method: DiscoveryMethod): string {
  const httpMethod = method.httpMethod;
  const methodPath = method.flatPath ?? method.path;
  if (!httpMethod || !methodPath) {
    throw new Error(
      `Gmail method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  if (!methodPath.startsWith("gmail/")) {
    throw new Error(`Unexpected Gmail method path: ${methodPath}`);
  }
  return `${httpMethod.toUpperCase()} /${methodPath.slice("gmail/".length)}`;
}

function uploadRuleForMethod(
  method: DiscoveryMethod,
  kind: Exclude<GmailRouteKeyKind, "base">,
): string | null {
  const httpMethod = method.httpMethod;
  if (!httpMethod) {
    throw new Error(`Gmail upload method missing httpMethod: ${method.id}`);
  }

  const protocol =
    kind === "upload"
      ? method.mediaUpload?.protocols?.simple
      : method.mediaUpload?.protocols?.resumable;
  if (!protocol?.path) return null;

  const prefix =
    kind === "upload" ? "/upload/gmail/" : "/resumable/upload/gmail/";
  if (!protocol.path.startsWith(prefix)) {
    throw new Error(
      `Unexpected Gmail ${kind} media upload path for ${method.id ?? "unknown"}: ${protocol.path}`,
    );
  }

  return `${httpMethod.toUpperCase()} /${protocol.path.slice(prefix.length)}`;
}

export function buildGmailOfficialRouteKeys(
  discovery: GmailDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  let uploadRouteCount = 0;
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    const rule = baseRuleForMethod(method);
    routeKeys.add(`base:${rule}`);
    if (method.supportsMediaUpload) {
      const uploadRule = uploadRuleForMethod(method, "upload");
      const resumableUploadRule = uploadRuleForMethod(
        method,
        "resumable-upload",
      );
      if (!uploadRule && !resumableUploadRule) {
        throw new Error(
          `Gmail Discovery reports media upload support without upload protocol paths: ${method.id ?? rule}`,
        );
      }
      if (uploadRule) {
        uploadRouteCount += 1;
        routeKeys.add(`upload:${uploadRule}`);
      }
      if (resumableUploadRule) {
        uploadRouteCount += 1;
        routeKeys.add(`resumable-upload:${resumableUploadRule}`);
      }
    }
  }
  if (uploadRouteCount === 0) {
    throw new Error("Gmail Discovery reports no upload methods");
  }
  return routeKeys;
}

function sortedValues(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertUniquePermissionNames(
  manifest: readonly GmailManifestPermission[],
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
      `Gmail permission manifest has duplicate permission names:\n${sortedValues(duplicates).join("\n")}`,
    );
  }
}

export function validateGmailPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GmailManifestPermission[],
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
    messages.push(`Unknown Gmail manifest route keys:\n${unknown.join("\n")}`);
  }
  if (missing.length > 0) {
    messages.push(`Missing Gmail manifest route keys:\n${missing.join("\n")}`);
  }
  if (duplicates.length > 0) {
    messages.push(
      `Duplicate Gmail manifest route assignments:\n${duplicates.join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function routeKeyParts(routeKey: string): {
  readonly kind: GmailRouteKeyKind;
  readonly rule: string;
} {
  const separatorIndex = routeKey.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed Gmail route key: ${routeKey}`);
  }
  const kind = routeKey.slice(0, separatorIndex);
  const rule = routeKey.slice(separatorIndex + 1);
  if (kind !== "base" && kind !== "upload" && kind !== "resumable-upload") {
    throw new Error(`Unknown Gmail route key kind: ${routeKey}`);
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE) \//.test(rule)) {
    throw new Error(`Malformed Gmail route rule: ${routeKey}`);
  }
  return { kind, rule };
}

function permissionsForKind(kind: GmailRouteKeyKind): PermissionGroup[] {
  return GMAIL_PERMISSION_MANIFEST.flatMap((permission) => {
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

function gmailCategories(): Record<string, string> {
  const categories: Record<string, string> = {};
  for (const permission of GMAIL_PERMISSION_MANIFEST) {
    categories[permission.name] = permission.category;
  }
  return categories;
}

function generateTypeScript(apis: readonly ApiEntry[]): string {
  const lines: string[] = [
    "// Auto-generated from Google's Gmail Discovery API and vm0's Gmail permission manifest.",
    `// Source: ${GMAIL_DISCOVERY_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:gmail",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const gmailFirewall = {",
    '  name: "gmail",',
    '  description: "Gmail API",',
    "  placeholders: {",
    `    GMAIL_TOKEN: "${escapeString(GMAIL_TOKEN_PLACEHOLDER)}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of apis) {
    lines.push("    {");
    lines.push(`      base: "${api.base}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push('          Authorization: "Bearer ${{ secrets.GMAIL_TOKEN }}",');
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
      "gmailDefaultAllowed",
      "gmailFirewall",
      DEFAULT_ALLOWED_GMAIL_PERMISSIONS,
    ),
  );
  lines.push(
    ...renderDefaultUnknownPolicy("gmailDefaultUnknownPolicy", "deny"),
  );
  lines.push(
    ...renderCategories("gmailCategories", "gmailFirewall", {
      categories: gmailCategories(),
      displayOrder: [...GMAIL_CATEGORY_ORDER],
    }),
  );

  return lines.join("\n");
}

async function loadGmailDiscovery(): Promise<GmailDiscoveryDocument> {
  const res = await fetchSpec(GMAIL_DISCOVERY_URL, "gmail discovery document");
  return (await res.json()) as GmailDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGmailDiscovery();
  const officialRouteKeys = buildGmailOfficialRouteKeys(discovery);
  validateGmailPermissionManifest(officialRouteKeys, GMAIL_PERMISSION_MANIFEST);

  const apis: ApiEntry[] = [
    {
      base: GMAIL_BASE_URL,
      kind: "base",
      permissions: permissionsForKind("base"),
    },
    {
      base: GMAIL_UPLOAD_BASE_URL,
      kind: "upload",
      permissions: permissionsForKind("upload"),
    },
    {
      base: GMAIL_RESUMABLE_UPLOAD_BASE_URL,
      kind: "resumable-upload",
      permissions: permissionsForKind("resumable-upload"),
    },
  ];

  const ts = generateTypeScript(apis);
  logStats(
    GMAIL_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("gmail", ts, import.meta.dirname);
}
