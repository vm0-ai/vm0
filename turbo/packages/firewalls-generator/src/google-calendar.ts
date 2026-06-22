/**
 * Generate the Google Calendar firewall config.
 *
 * Google Calendar Discovery method scopes are OAuth authorization constraints,
 * not vm0 firewall permission groups. Keep route coverage official by loading
 * Calendar v3 Discovery, but keep the firewall permission taxonomy explicit
 * here.
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

type GoogleCalendarRouteKeyKind = "base";

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

export interface GoogleCalendarDiscoveryDocument {
  version?: string;
  servicePath?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleCalendarManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

interface ApiEntry {
  readonly base: string;
  readonly kind: GoogleCalendarRouteKeyKind;
  readonly permissions: readonly PermissionGroup[];
}

export const GOOGLE_CALENDAR_DISCOVERY_URL =
  "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";

const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar";
const GOOGLE_CALENDAR_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_CALENDAR_PERMISSIONS = [
  "calendars.read",
  "events.read",
  "calendar-list.read",
  "settings.read",
  "freebusy.query",
  "colors.read",
];

const GOOGLE_CALENDAR_CATEGORY_ORDER = [
  "Calendars",
  "Events",
  "Calendar List",
  "Sharing",
  "Settings",
  "Availability",
  "Notifications",
] as const;

export const GOOGLE_CALENDAR_PERMISSION_MANIFEST: readonly GoogleCalendarManifestPermission[] =
  [
    {
      name: "calendars.read",
      category: "Calendars",
      description: "Read Google Calendar metadata.",
      routeKeys: ["base:GET /v3/calendars/{calendarId}"],
    },
    {
      name: "calendars.write",
      category: "Calendars",
      description: "Create and update secondary Google calendars.",
      routeKeys: [
        "base:PATCH /v3/calendars/{calendarId}",
        "base:POST /v3/calendars",
        "base:PUT /v3/calendars/{calendarId}",
      ],
    },
    {
      name: "calendars.delete",
      category: "Calendars",
      description: "Delete Google calendars.",
      routeKeys: ["base:DELETE /v3/calendars/{calendarId}"],
    },
    {
      name: "calendars.clear",
      category: "Calendars",
      description: "Clear all events from a Google calendar.",
      routeKeys: ["base:POST /v3/calendars/{calendarId}/clear"],
    },
    {
      name: "acl.read",
      category: "Sharing",
      description: "Read Google Calendar sharing ACL rules.",
      routeKeys: [
        "base:GET /v3/calendars/{calendarId}/acl",
        "base:GET /v3/calendars/{calendarId}/acl/{ruleId}",
      ],
    },
    {
      name: "acl.write",
      category: "Sharing",
      description: "Create and update Google Calendar sharing ACL rules.",
      routeKeys: [
        "base:PATCH /v3/calendars/{calendarId}/acl/{ruleId}",
        "base:POST /v3/calendars/{calendarId}/acl",
        "base:PUT /v3/calendars/{calendarId}/acl/{ruleId}",
      ],
    },
    {
      name: "acl.delete",
      category: "Sharing",
      description: "Delete Google Calendar sharing ACL rules.",
      routeKeys: ["base:DELETE /v3/calendars/{calendarId}/acl/{ruleId}"],
    },
    {
      name: "events.read",
      category: "Events",
      description: "Read Google Calendar events and recurring instances.",
      routeKeys: [
        "base:GET /v3/calendars/{calendarId}/events",
        "base:GET /v3/calendars/{calendarId}/events/{eventId}",
        "base:GET /v3/calendars/{calendarId}/events/{eventId}/instances",
      ],
    },
    {
      name: "events.write",
      category: "Events",
      description: "Create, update, import, quick-add, and move events.",
      routeKeys: [
        "base:PATCH /v3/calendars/{calendarId}/events/{eventId}",
        "base:POST /v3/calendars/{calendarId}/events",
        "base:POST /v3/calendars/{calendarId}/events/import",
        "base:POST /v3/calendars/{calendarId}/events/quickAdd",
        "base:POST /v3/calendars/{calendarId}/events/{eventId}/move",
        "base:PUT /v3/calendars/{calendarId}/events/{eventId}",
      ],
    },
    {
      name: "events.delete",
      category: "Events",
      description: "Delete Google Calendar events.",
      routeKeys: ["base:DELETE /v3/calendars/{calendarId}/events/{eventId}"],
    },
    {
      name: "calendar-list.read",
      category: "Calendar List",
      description: "Read the user's subscribed calendar list.",
      routeKeys: [
        "base:GET /v3/users/me/calendarList",
        "base:GET /v3/users/me/calendarList/{calendarId}",
      ],
    },
    {
      name: "calendar-list.write",
      category: "Calendar List",
      description: "Add and update calendars in the user's calendar list.",
      routeKeys: [
        "base:PATCH /v3/users/me/calendarList/{calendarId}",
        "base:POST /v3/users/me/calendarList",
        "base:PUT /v3/users/me/calendarList/{calendarId}",
      ],
    },
    {
      name: "calendar-list.delete",
      category: "Calendar List",
      description: "Remove calendars from the user's calendar list.",
      routeKeys: ["base:DELETE /v3/users/me/calendarList/{calendarId}"],
    },
    {
      name: "settings.read",
      category: "Settings",
      description: "Read the user's Google Calendar settings.",
      routeKeys: [
        "base:GET /v3/users/me/settings",
        "base:GET /v3/users/me/settings/{setting}",
      ],
    },
    {
      name: "freebusy.query",
      category: "Availability",
      description: "Query free/busy availability for calendars.",
      routeKeys: ["base:POST /v3/freeBusy"],
    },
    {
      name: "colors.read",
      category: "Availability",
      description: "Read Google Calendar color definitions.",
      routeKeys: ["base:GET /v3/colors"],
    },
    {
      name: "notifications.write",
      category: "Notifications",
      description: "Create and stop Google Calendar notification channels.",
      routeKeys: [
        "base:POST /v3/calendars/{calendarId}/acl/watch",
        "base:POST /v3/calendars/{calendarId}/events/watch",
        "base:POST /v3/channels/stop",
        "base:POST /v3/users/me/calendarList/watch",
        "base:POST /v3/users/me/settings/watch",
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

function versionPrefix(discovery: GoogleCalendarDiscoveryDocument): string {
  const servicePath = discovery.servicePath ?? "";
  if (!servicePath) return "";
  const parts = servicePath.replace(/\/$/, "").split("/");
  const lastPart = parts.at(-1);
  return parts.length > 1 && lastPart ? `${lastPart}/` : "";
}

function ruleForMethod(
  discovery: GoogleCalendarDiscoveryDocument,
  method: DiscoveryMethod,
): string {
  const httpMethod = method.httpMethod;
  const methodPath = method.flatPath ?? method.path;
  if (!httpMethod || !methodPath) {
    throw new Error(
      `Google Calendar method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  return `${httpMethod.toUpperCase()} /${versionPrefix(discovery)}${methodPath}`;
}

export function buildGoogleCalendarOfficialRouteKeys(
  discovery: GoogleCalendarDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    routeKeys.add(`base:${ruleForMethod(discovery, method)}`);
  }
  return routeKeys;
}

function sortedValues(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertUniquePermissionNames(
  manifest: readonly GoogleCalendarManifestPermission[],
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
      `Google Calendar permission manifest has duplicate permission names:\n${sortedValues(duplicates).join("\n")}`,
    );
  }
}

export function validateGoogleCalendarPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleCalendarManifestPermission[],
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
      `Unknown Google Calendar manifest route keys:\n${unknown.join("\n")}`,
    );
  }
  if (missing.length > 0) {
    messages.push(
      `Missing Google Calendar manifest route keys:\n${missing.join("\n")}`,
    );
  }
  if (duplicates.length > 0) {
    messages.push(
      `Duplicate Google Calendar manifest route assignments:\n${duplicates.join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function routeKeyParts(routeKey: string): {
  readonly kind: GoogleCalendarRouteKeyKind;
  readonly rule: string;
} {
  const separatorIndex = routeKey.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed Google Calendar route key: ${routeKey}`);
  }
  const kind = routeKey.slice(0, separatorIndex);
  const rule = routeKey.slice(separatorIndex + 1);
  if (kind !== "base") {
    throw new Error(`Unknown Google Calendar route key kind: ${routeKey}`);
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE) \//.test(rule)) {
    throw new Error(`Malformed Google Calendar route rule: ${routeKey}`);
  }
  return { kind, rule };
}

function permissionsForKind(
  kind: GoogleCalendarRouteKeyKind,
): PermissionGroup[] {
  return GOOGLE_CALENDAR_PERMISSION_MANIFEST.flatMap((permission) => {
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

function googleCalendarCategories(): Record<string, string> {
  const categories: Record<string, string> = {};
  for (const permission of GOOGLE_CALENDAR_PERMISSION_MANIFEST) {
    categories[permission.name] = permission.category;
  }
  return categories;
}

function generateTypeScript(apis: readonly ApiEntry[]): string {
  const lines: string[] = [
    "// Auto-generated from Google's Calendar Discovery API and vm0's Calendar permission manifest.",
    `// Source: ${GOOGLE_CALENDAR_DISCOVERY_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-calendar",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const googleCalendarFirewall = {",
    '  name: "google-calendar",',
    '  description: "Google Calendar API",',
    "  placeholders: {",
    `    GOOGLE_CALENDAR_TOKEN: "${escapeString(GOOGLE_CALENDAR_TOKEN_PLACEHOLDER)}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of apis) {
    lines.push("    {");
    lines.push(`      base: "${escapeString(api.base)}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      '          Authorization: "Bearer ${{ secrets.GOOGLE_CALENDAR_TOKEN }}",',
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
      "googleCalendarDefaultAllowed",
      "googleCalendarFirewall",
      DEFAULT_ALLOWED_GOOGLE_CALENDAR_PERMISSIONS,
    ),
  );
  lines.push(
    ...renderDefaultUnknownPolicy("googleCalendarDefaultUnknownPolicy", "deny"),
  );
  lines.push(
    ...renderCategories("googleCalendarCategories", "googleCalendarFirewall", {
      categories: googleCalendarCategories(),
      displayOrder: [...GOOGLE_CALENDAR_CATEGORY_ORDER],
    }),
  );

  return lines.join("\n");
}

async function loadGoogleCalendarDiscovery(): Promise<GoogleCalendarDiscoveryDocument> {
  const res = await fetchSpec(
    GOOGLE_CALENDAR_DISCOVERY_URL,
    "google-calendar discovery document",
  );
  return (await res.json()) as GoogleCalendarDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGoogleCalendarDiscovery();
  const officialRouteKeys = buildGoogleCalendarOfficialRouteKeys(discovery);
  validateGoogleCalendarPermissionManifest(
    officialRouteKeys,
    GOOGLE_CALENDAR_PERMISSION_MANIFEST,
  );

  const apis: ApiEntry[] = [
    {
      base: GOOGLE_CALENDAR_BASE_URL,
      kind: "base",
      permissions: permissionsForKind("base"),
    },
  ];

  const ts = generateTypeScript(apis);
  logStats(
    GOOGLE_CALENDAR_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-calendar", ts, import.meta.dirname);
}
