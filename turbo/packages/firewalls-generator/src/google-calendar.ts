/**
 * Generate the Google Calendar firewall config.
 *
 * Google Calendar Discovery method scopes are OAuth authorization constraints,
 * not vm0 firewall permission groups. Keep route coverage official by loading
 * Calendar v3 Discovery, but keep the firewall permission taxonomy explicit
 * here.
 */

import { fetchSpec, logStats, writeOutput } from "./codegen";
import {
  compileGoogleManifestFirewall,
  renderGoogleManifestFirewall,
  validateGoogleManifestPermissionManifest,
} from "./google-manifest";
import type { GoogleManifestPermission } from "./google-manifest";

const GOOGLE_CALENDAR_ROUTE_KEY_KINDS = ["base"] as const;
type GoogleCalendarRouteKeyKind =
  (typeof GOOGLE_CALENDAR_ROUTE_KEY_KINDS)[number];

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

export interface GoogleCalendarManifestPermission extends GoogleManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
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

export function validateGoogleCalendarPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleCalendarManifestPermission[],
): void {
  validateGoogleManifestPermissionManifest({
    serviceLabel: "Google Calendar",
    routeKinds: GOOGLE_CALENDAR_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest,
    categoryOrder: GOOGLE_CALENDAR_CATEGORY_ORDER,
  });
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
  const compiled = compileGoogleManifestFirewall<
    GoogleCalendarRouteKeyKind,
    GoogleCalendarManifestPermission
  >({
    serviceLabel: "Google Calendar",
    routeKinds: GOOGLE_CALENDAR_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest: GOOGLE_CALENDAR_PERMISSION_MANIFEST,
    apis: [
      {
        base: GOOGLE_CALENDAR_BASE_URL,
        kind: "base",
      },
    ],
    categoryOrder: GOOGLE_CALENDAR_CATEGORY_ORDER,
  });
  if (!compiled.categories) {
    throw new Error("Google Calendar categories were not compiled");
  }

  const ts = renderGoogleManifestFirewall({
    headerLines: [
      "// Auto-generated from Google's Calendar Discovery API and vm0's Calendar permission manifest.",
      `// Source: ${GOOGLE_CALENDAR_DISCOVERY_URL}`,
      "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-calendar",
      "//",
      "// DO NOT EDIT THIS FILE MANUALLY.",
    ],
    firewallVarName: "googleCalendarFirewall",
    firewallName: "google-calendar",
    firewallDescription: "Google Calendar API",
    tokenPlaceholderName: "GOOGLE_CALENDAR_TOKEN",
    tokenPlaceholderValue: GOOGLE_CALENDAR_TOKEN_PLACEHOLDER,
    apis: compiled.apis,
    defaultAllowed: {
      varName: "googleCalendarDefaultAllowed",
      permissions: DEFAULT_ALLOWED_GOOGLE_CALENDAR_PERMISSIONS,
    },
    defaultUnknownPolicy: {
      varName: "googleCalendarDefaultUnknownPolicy",
      policy: "deny",
    },
    categories: {
      varName: "googleCalendarCategories",
      config: compiled.categories,
    },
  });
  logStats(
    GOOGLE_CALENDAR_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-calendar", ts, import.meta.dirname);
}
