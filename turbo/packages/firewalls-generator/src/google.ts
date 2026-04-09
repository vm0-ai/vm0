/**
 * Generate Google API firewall configs from Google Discovery API documents.
 *
 * All Google APIs (Gmail, Sheets, Docs, Drive, Calendar) use the same Discovery
 * API format: resources → methods → {path, httpMethod, scopes}.
 */

import {
  escapeString,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

// Short scope names: strip the common prefix for readable permission names.
const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

// Some Google APIs use non-standard full-access scope URLs.
const SPECIAL_SCOPES: Record<string, string> = {
  "https://mail.google.com/": "gmail",
  "https://www.googleapis.com/auth/drive": "drive",
  "https://www.googleapis.com/auth/calendar": "calendar",
};

function shortScope(scope: string): string {
  const special = SPECIAL_SCOPES[scope];
  if (special) return special;
  if (scope.startsWith(SCOPE_PREFIX)) return scope.slice(SCOPE_PREFIX.length);
  return scope;
}

// ── Discovery document types ─────────────────────────────────────────────

interface DiscoveryMethod {
  id?: string;
  httpMethod?: string;
  path?: string;
  scopes?: string[];
  supportsMediaUpload?: boolean;
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

interface DiscoveryDocument {
  version?: string;
  servicePath?: string;
  resources?: Record<string, DiscoveryResource>;
  auth?: {
    oauth2?: {
      scopes?: Record<string, { description?: string }>;
    };
  };
}

// ── Discovery document parsing ───────────────────────────────────────────

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

// ── Scopeless methods ───────────────────────────────────────────────────
// Some Discovery methods lack OAuth scopes (e.g. deprecated or partner-only
// YouTube endpoints). They are skipped during generation. If a new scopeless
// method appears, the generator will fail until it is added here.

const SCOPELESS_METHODS = new Set([
  "youtube.youtube.v3.updateCommentThreads",
  "youtube.thirdPartyLinks.list",
  "youtube.thirdPartyLinks.insert",
  "youtube.thirdPartyLinks.update",
  "youtube.thirdPartyLinks.delete",
]);

// ── Grouping ─────────────────────────────────────────────────────────────

function buildGroups(
  discovery: DiscoveryDocument,
  stripPrefix: string,
  uploadOnly?: boolean,
): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  const strip = stripPrefix ? `${stripPrefix}/` : "";

  // servicePath is non-empty for APIs with relative paths (Drive, Calendar).
  // Extract just the version part (e.g. "drive/v3/" → "v3/") to prepend.
  const servicePath = discovery.servicePath ?? "";
  let versionPrefix = "";
  if (servicePath) {
    // servicePath is like "drive/v3/" or "calendar/v3/" — take last segment
    const parts = servicePath.replace(/\/$/, "").split("/");
    const lastPart = parts.at(-1);
    versionPrefix = parts.length > 1 && lastPart ? `${lastPart}/` : "";
  }

  for (const method of extractMethods(discovery.resources ?? {})) {
    // Filter: only upload methods, or only non-upload methods
    if (uploadOnly && !method.supportsMediaUpload) continue;

    const httpMethod = method.httpMethod;
    const methodPath = method.path;
    const scopes = method.scopes;

    if (!httpMethod || !methodPath) {
      throw new Error(
        `Method missing httpMethod or path: ${method.id ?? "unknown"}`,
      );
    }
    if (!scopes || scopes.length === 0) {
      const id = method.id ?? `${httpMethod} ${methodPath}`;
      if (!SCOPELESS_METHODS.has(id)) {
        throw new Error(
          `Method has no scopes: ${id}\n` +
            "If this is expected, add it to SCOPELESS_METHODS in google.ts.",
        );
      }
      continue;
    }

    // For APIs with servicePath (Drive, Calendar): paths are relative,
    // prepend version prefix. e.g. "about" → "v3/about"
    // For APIs without servicePath (Gmail, Docs, Sheets): paths include
    // service prefix, strip it. e.g. "gmail/v1/users/{id}" → "v1/users/{id}"
    let rulePath: string;
    if (versionPrefix) {
      rulePath = `${versionPrefix}${methodPath}`;
    } else if (strip && methodPath.startsWith(strip)) {
      rulePath = methodPath.slice(strip.length);
    } else {
      rulePath = methodPath;
    }

    const rule = `${httpMethod.toUpperCase()} /${rulePath}`;
    for (const scope of scopes) {
      const scopeName = shortScope(scope);
      let ruleSet = groups.get(scopeName);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(scopeName, ruleSet);
      }
      ruleSet.add(rule);
    }
  }

  // Get scope descriptions from discovery doc
  const scopeDescs = new Map<string, string>();
  const oauthScopes = discovery.auth?.oauth2?.scopes ?? {};
  for (const [scopeUrl, info] of Object.entries(oauthScopes)) {
    scopeDescs.set(shortScope(scopeUrl), info.description ?? "");
  }

  return [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      description: scopeDescs.get(name) ?? "",
      rules: sanitizeAndSortRules([...ruleSet]),
    }));
}

// ── API entry ────────────────────────────────────────────────────────────

interface ApiEntry {
  base: string;
  permissions: PermissionGroup[];
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(
  apis: ApiEntry[],
  config: GoogleFirewallConfig,
): string {
  const exportName = config.serviceName
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/^([a-z])/, (_, c: string) => c.toLowerCase());

  const sourceLines = config.discoveryUrls.map((u) => `// Source: ${u}`);
  const lines: string[] = [
    "// Auto-generated from Google's Discovery API.",
    ...sourceLines,
    `// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:${config.serviceName}`,
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../contracts/firewalls";',
    "",
    `export const ${exportName}Firewall = {`,
    `  name: "${config.serviceName}",`,
    `  description: "${escapeString(config.serviceDescription)}",`,
    "  placeholders: {",
    `    ${config.placeholderKey}: "${config.placeholderValue}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of apis) {
    lines.push("    {");
    lines.push(`      base: "${api.base}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    for (const [header, value] of Object.entries(config.auth.headers)) {
      lines.push(
        `          "${escapeString(header)}": "${escapeString(value)}",`,
      );
    }
    lines.push("        },");
    lines.push("      },");
    lines.push("      permissions: [");
    lines.push(...renderPermissions(api.permissions));
    lines.push("      ],");
    lines.push("    },");
  }

  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push("");

  return lines.join("\n");
}

// ── Generation ───────────────────────────────────────────────────────────

interface GoogleFirewallAuth {
  /** Auth header entries (e.g. { Authorization: "Bearer ${{ secrets.TOKEN }}" }). */
  headers: Record<string, string>;
}

interface GoogleFirewallConfig {
  /** Discovery URLs to fetch (supports multiple versions). */
  discoveryUrls: string[];
  /** Base URL: domain + service path, no version (e.g. "https://www.googleapis.com/drive"). */
  baseUrl: string;
  /**
   * Upload base URLs for APIs with media upload support (simple + resumable).
   * Required if Discovery API reports supportsMediaUpload on any method.
   */
  uploadBaseUrls?: string[];
  /**
   * Prefix to strip from Discovery paths (for APIs where paths include the service name).
   * e.g. "gmail" strips "gmail/" from "gmail/v1/users/{id}" → "v1/users/{id}".
   * Leave empty for APIs with relative paths (Drive, Calendar) — version is derived from servicePath.
   */
  stripPrefix: string;
  serviceName: string;
  serviceDescription: string;
  placeholderKey: string;
  placeholderValue: string;
  /** Auth header configuration for the generated firewall. */
  auth: GoogleFirewallAuth;
}

function mergePermissions(
  target: PermissionGroup[],
  source: PermissionGroup[],
): void {
  for (const perm of source) {
    const existing = target.find((p) => p.name === perm.name);
    if (existing) {
      const ruleSet = new Set(existing.rules);
      for (const rule of perm.rules) ruleSet.add(rule);
      existing.rules = sanitizeAndSortRules([...ruleSet]);
      if (!existing.description && perm.description) {
        existing.description = perm.description;
      }
    } else {
      target.push({ ...perm });
    }
  }
}

async function generateGoogleFirewall(
  config: GoogleFirewallConfig,
): Promise<void> {
  const allPermissions: PermissionGroup[] = [];
  const uploadPermissions: PermissionGroup[] = [];
  let hasUpload = false;

  for (const discoveryUrl of config.discoveryUrls) {
    const res = await fetchSpec(
      discoveryUrl,
      `${config.serviceName} discovery document`,
    );
    const discovery = (await res.json()) as DiscoveryDocument;
    console.error(`  API version: ${discovery.version ?? "unknown"}`);

    mergePermissions(
      allPermissions,
      buildGroups(discovery, config.stripPrefix),
    );

    // Build upload-specific permissions (only methods with supportsMediaUpload)
    const uploadGroups = buildGroups(discovery, config.stripPrefix, true);
    if (uploadGroups.length > 0) {
      hasUpload = true;
      mergePermissions(uploadPermissions, uploadGroups);
    }
  }

  // Validate: Discovery upload support must match config
  const hasUploadConfig =
    config.uploadBaseUrls && config.uploadBaseUrls.length > 0;
  if (hasUpload && !hasUploadConfig) {
    throw new Error(
      `${config.serviceName}: Discovery API reports upload methods but config is missing uploadBaseUrls`,
    );
  }
  if (!hasUpload && hasUploadConfig) {
    throw new Error(
      `${config.serviceName}: config has uploadBaseUrls but Discovery API reports no upload methods`,
    );
  }

  // Sort by name
  allPermissions.sort((a, b) => a.name.localeCompare(b.name));
  uploadPermissions.sort((a, b) => a.name.localeCompare(b.name));

  // Build API entries
  const apis: ApiEntry[] = [
    { base: config.baseUrl, permissions: allPermissions },
  ];
  for (const uploadBase of config.uploadBaseUrls ?? []) {
    apis.push({ base: uploadBase, permissions: uploadPermissions });
  }

  const ts = generateTypeScript(apis, config);

  logStats(allPermissions);
  writeOutput(config.serviceName, ts, import.meta.dirname);
}

// ── Service configs ──────────────────────────────────────────────────────

const OAUTH_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

function bearerAuth(placeholderKey: string): GoogleFirewallAuth {
  return {
    headers: {
      Authorization: `Bearer \${{ secrets.${placeholderKey} }}`,
    },
  };
}

const CONFIGS: Record<string, GoogleFirewallConfig> = {
  gmail: {
    discoveryUrls: ["https://gmail.googleapis.com/$discovery/rest?version=v1"],
    baseUrl: "https://gmail.googleapis.com/gmail",
    uploadBaseUrls: [
      "https://gmail.googleapis.com/upload/gmail",
      "https://gmail.googleapis.com/resumable/upload/gmail",
    ],
    stripPrefix: "gmail",
    serviceName: "gmail",
    serviceDescription: "Gmail API",
    placeholderKey: "GMAIL_TOKEN",
    placeholderValue: OAUTH_PLACEHOLDER,
    auth: bearerAuth("GMAIL_TOKEN"),
  },
  "google-calendar": {
    discoveryUrls: [
      "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
    ],
    baseUrl: "https://www.googleapis.com/calendar",
    stripPrefix: "",
    serviceName: "google-calendar",
    serviceDescription: "Google Calendar API",
    placeholderKey: "GOOGLE_CALENDAR_TOKEN",
    placeholderValue: OAUTH_PLACEHOLDER,
    auth: bearerAuth("GOOGLE_CALENDAR_TOKEN"),
  },
  "google-docs": {
    discoveryUrls: ["https://docs.googleapis.com/$discovery/rest?version=v1"],
    baseUrl: "https://docs.googleapis.com",
    stripPrefix: "",
    serviceName: "google-docs",
    serviceDescription: "Google Docs API",
    placeholderKey: "GOOGLE_DOCS_TOKEN",
    placeholderValue: OAUTH_PLACEHOLDER,
    auth: bearerAuth("GOOGLE_DOCS_TOKEN"),
  },
  "google-drive": {
    discoveryUrls: [
      "https://www.googleapis.com/discovery/v1/apis/drive/v2/rest",
      "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    ],
    baseUrl: "https://www.googleapis.com/drive",
    uploadBaseUrls: [
      "https://www.googleapis.com/upload/drive",
      "https://www.googleapis.com/resumable/upload/drive",
    ],
    stripPrefix: "",
    serviceName: "google-drive",
    serviceDescription: "Google Drive API",
    placeholderKey: "GOOGLE_DRIVE_TOKEN",
    placeholderValue: OAUTH_PLACEHOLDER,
    auth: bearerAuth("GOOGLE_DRIVE_TOKEN"),
  },
  "google-sheets": {
    discoveryUrls: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
    baseUrl: "https://sheets.googleapis.com",
    stripPrefix: "",
    serviceName: "google-sheets",
    serviceDescription: "Google Sheets API",
    placeholderKey: "GOOGLE_SHEETS_TOKEN",
    placeholderValue: OAUTH_PLACEHOLDER,
    auth: bearerAuth("GOOGLE_SHEETS_TOKEN"),
  },
  youtube: {
    discoveryUrls: [
      "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest",
    ],
    baseUrl: "https://youtube.googleapis.com/youtube",
    uploadBaseUrls: [
      "https://youtube.googleapis.com/upload/youtube",
      "https://youtube.googleapis.com/resumable/upload/youtube",
    ],
    stripPrefix: "youtube",
    serviceName: "youtube",
    serviceDescription: "YouTube Data API",
    placeholderKey: "YOUTUBE_TOKEN",
    // Format: AIza + 35 word chars (gitleaks: gcp-api-key)
    placeholderValue: "AIzaSyBCoffeeSafeLocalCoffeeSafeLocalCo",
    auth: {
      headers: {
        "X-Goog-Api-Key": "${{ secrets.YOUTUBE_TOKEN }}",
      },
    },
  },
};

export function createGoogleGenerator(name: string): () => Promise<void> {
  const config = CONFIGS[name];
  if (!config) {
    throw new Error(
      `Unknown Google service: ${name}. Available: ${Object.keys(CONFIGS).join(", ")}`,
    );
  }
  return () => generateGoogleFirewall(config);
}

export const googleServiceNames = Object.keys(CONFIGS);
