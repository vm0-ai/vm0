/**
 * Generate the Google Meet firewall config.
 *
 * Google Meet Discovery method scopes are OAuth authorization constraints, not
 * vm0 firewall permission groups. Keep route coverage official by loading Meet
 * v2 Discovery, but keep the firewall permission taxonomy explicit here.
 */

import { fetchSpec, logStats, writeOutput } from "./codegen";
import {
  compileGoogleManifestFirewall,
  renderGoogleManifestFirewall,
  validateGoogleManifestPermissionManifest,
} from "./google-manifest";
import type { GoogleManifestPermission } from "./google-manifest";

const GOOGLE_MEET_ROUTE_KEY_KINDS = ["base"] as const;
type GoogleMeetRouteKeyKind = (typeof GOOGLE_MEET_ROUTE_KEY_KINDS)[number];

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

export interface GoogleMeetDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface GoogleMeetManifestPermission extends GoogleManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

export const GOOGLE_MEET_DISCOVERY_URL =
  "https://meet.googleapis.com/$discovery/rest?version=v2";

const GOOGLE_MEET_BASE_URL = "https://meet.googleapis.com";
const GOOGLE_MEET_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_GOOGLE_MEET_PERMISSIONS = [
  "spaces.read",
  "conference-records.read",
  "participants.read",
  "participant-sessions.read",
  "recordings.read",
  "smart-notes.read",
  "transcripts.read",
  "transcript-entries.read",
];

const GOOGLE_MEET_CATEGORY_ORDER = [
  "Spaces",
  "Conference Records",
  "Participants",
  "Recordings",
  "Transcripts",
  "Smart Notes",
] as const;

export const GOOGLE_MEET_PERMISSION_MANIFEST: readonly GoogleMeetManifestPermission[] =
  [
    {
      name: "spaces.create",
      category: "Spaces",
      description: "Create Google Meet spaces.",
      routeKeys: ["base:POST /v2/spaces"],
    },
    {
      name: "spaces.read",
      category: "Spaces",
      description: "Read Google Meet spaces.",
      routeKeys: ["base:GET /v2/spaces/{spacesId}"],
    },
    {
      name: "spaces.write",
      category: "Spaces",
      description: "Update Google Meet spaces.",
      routeKeys: ["base:PATCH /v2/spaces/{spacesId}"],
    },
    {
      name: "spaces.end-active-conference",
      category: "Spaces",
      description: "End active conferences in Google Meet spaces.",
      routeKeys: ["base:POST /v2/spaces/{spacesId}:endActiveConference"],
    },
    {
      name: "conference-records.read",
      category: "Conference Records",
      description: "Read Google Meet conference records.",
      routeKeys: [
        "base:GET /v2/conferenceRecords",
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}",
      ],
    },
    {
      name: "participants.read",
      category: "Participants",
      description: "Read participants in Google Meet conference records.",
      routeKeys: [
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/participants",
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/participants/{participantsId}",
      ],
    },
    {
      name: "participant-sessions.read",
      category: "Participants",
      description:
        "Read participant sessions in Google Meet conference records.",
      routeKeys: [
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions",
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions/{participantSessionsId}",
      ],
    },
    {
      name: "recordings.read",
      category: "Recordings",
      description: "Read Google Meet conference recordings.",
      routeKeys: [
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/recordings",
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/recordings/{recordingsId}",
      ],
    },
    {
      name: "transcripts.read",
      category: "Transcripts",
      description: "Read Google Meet transcripts.",
      routeKeys: [
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts",
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}",
      ],
    },
    {
      name: "transcript-entries.read",
      category: "Transcripts",
      description: "Read Google Meet transcript entries.",
      routeKeys: [
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries",
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries/{entriesId}",
      ],
    },
    {
      name: "smart-notes.read",
      category: "Smart Notes",
      description: "Read Google Meet smart notes.",
      routeKeys: [
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/smartNotes",
        "base:GET /v2/conferenceRecords/{conferenceRecordsId}/smartNotes/{smartNotesId}",
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
      `Google Meet method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  const path = methodPath.startsWith("/") ? methodPath : `/${methodPath}`;
  return `${httpMethod.toUpperCase()} ${path}`;
}

export function buildGoogleMeetOfficialRouteKeys(
  discovery: GoogleMeetDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    routeKeys.add(`base:${ruleForMethod(method)}`);
  }
  return routeKeys;
}

export function validateGoogleMeetPermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly GoogleMeetManifestPermission[],
): void {
  validateGoogleManifestPermissionManifest({
    serviceLabel: "Google Meet",
    routeKinds: GOOGLE_MEET_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest,
    categoryOrder: GOOGLE_MEET_CATEGORY_ORDER,
  });
}

async function loadGoogleMeetDiscovery(): Promise<GoogleMeetDiscoveryDocument> {
  const res = await fetchSpec(
    GOOGLE_MEET_DISCOVERY_URL,
    "google-meet discovery document",
  );
  return (await res.json()) as GoogleMeetDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadGoogleMeetDiscovery();
  const officialRouteKeys = buildGoogleMeetOfficialRouteKeys(discovery);
  const compiled = compileGoogleManifestFirewall<
    GoogleMeetRouteKeyKind,
    GoogleMeetManifestPermission
  >({
    serviceLabel: "Google Meet",
    routeKinds: GOOGLE_MEET_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest: GOOGLE_MEET_PERMISSION_MANIFEST,
    apis: [
      {
        base: GOOGLE_MEET_BASE_URL,
        kind: "base",
      },
    ],
    categoryOrder: GOOGLE_MEET_CATEGORY_ORDER,
  });
  if (!compiled.categories) {
    throw new Error("Google Meet categories were not compiled");
  }

  const ts = renderGoogleManifestFirewall({
    headerLines: [
      "// Auto-generated from Google's Meet Discovery API and vm0's Meet permission manifest.",
      `// Source: ${GOOGLE_MEET_DISCOVERY_URL}`,
      "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-meet",
      "//",
      "// DO NOT EDIT THIS FILE MANUALLY.",
    ],
    firewallVarName: "googleMeetFirewall",
    firewallName: "google-meet",
    firewallDescription: "Google Meet API",
    tokenPlaceholderName: "GOOGLE_MEET_TOKEN",
    tokenPlaceholderValue: GOOGLE_MEET_TOKEN_PLACEHOLDER,
    apis: compiled.apis,
    defaultAllowed: {
      varName: "googleMeetDefaultAllowed",
      permissions: DEFAULT_ALLOWED_GOOGLE_MEET_PERMISSIONS,
    },
    defaultUnknownPolicy: {
      varName: "googleMeetDefaultUnknownPolicy",
      policy: "deny",
    },
    categories: {
      varName: "googleMeetCategories",
      config: compiled.categories,
    },
  });
  logStats(
    GOOGLE_MEET_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("google-meet", ts, import.meta.dirname);
}
