/**
 * Generate Strava firewall config from official Swagger spec.
 *
 * Data source: https://developers.strava.com/swagger/swagger.json
 *
 * Strava's Swagger 2.0 spec does NOT annotate scopes per endpoint (the
 * global security uses a meaningless "public" placeholder). Instead,
 * scope requirements are documented in each endpoint's description text.
 *
 * We fetch the spec to get the canonical endpoint list, then apply a
 * manually maintained scope mapping (derived from the official docs).
 * Unknown endpoints cause a build error to catch spec changes.
 */

import {
  ALL_METHODS,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  stripQueryFragment,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

const SPEC_URL = "https://developers.strava.com/swagger/swagger.json";

const PLACEHOLDER_VALUE =
  "CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffe";

// ── Swagger types ───────────────────────────────────────────────────────

interface SwaggerSpec {
  basePath?: string;
  paths?: Record<string, Record<string, unknown>>;
}

// ── Scope mapping ───────────────────────────────────────────────────────
// Manually maintained from Strava's official API reference docs.
// Each endpoint maps to one or more official Strava scopes. Multiple scopes
// means the endpoint is accessible with ANY of those scopes (tiered access).
// Source: https://developers.strava.com/docs/reference/

const SCOPE_MAP: Record<string, string[]> = {
  // Activities — write
  "POST /api/v3/activities": ["activity:write"],
  "PUT /api/v3/activities/{id}": ["activity:write"],
  // Activities — read (activity:read for public, activity:read_all for Only Me)
  "GET /api/v3/activities/{id}": ["activity:read", "activity:read_all"],
  "GET /api/v3/activities/{id}/comments": [
    "activity:read",
    "activity:read_all",
  ],
  "GET /api/v3/activities/{id}/kudos": ["activity:read", "activity:read_all"],
  "GET /api/v3/activities/{id}/laps": ["activity:read", "activity:read_all"],
  "GET /api/v3/activities/{id}/streams": ["activity:read", "activity:read_all"],
  "GET /api/v3/activities/{id}/zones": ["activity:read", "activity:read_all"],
  "GET /api/v3/athlete/activities": ["activity:read", "activity:read_all"],
  // Athlete profile
  "GET /api/v3/athlete": ["read", "profile:read_all"],
  "PUT /api/v3/athlete": ["profile:write"],
  "GET /api/v3/athlete/zones": ["profile:read_all"],
  "GET /api/v3/athletes/{id}/stats": ["read"],
  // Clubs — basic read access
  "GET /api/v3/athlete/clubs": ["read"],
  "GET /api/v3/clubs/{id}": ["read"],
  "GET /api/v3/clubs/{id}/activities": ["read"],
  "GET /api/v3/clubs/{id}/admins": ["read"],
  "GET /api/v3/clubs/{id}/members": ["read"],
  // Gear
  "GET /api/v3/gear/{id}": ["read"],
  // Routes (read for public, read_all for private)
  "GET /api/v3/athletes/{id}/routes": ["read", "read_all"],
  "GET /api/v3/routes/{id}": ["read", "read_all"],
  "GET /api/v3/routes/{id}/export_gpx": ["read", "read_all"],
  "GET /api/v3/routes/{id}/export_tcx": ["read", "read_all"],
  "GET /api/v3/routes/{id}/streams": ["read", "read_all"],
  // Segments (read for public, read_all for private)
  "GET /api/v3/segments/explore": ["read"],
  "GET /api/v3/segments/starred": ["read", "read_all"],
  "GET /api/v3/segments/{id}": ["read", "read_all"],
  "PUT /api/v3/segments/{id}/starred": ["profile:write"],
  "GET /api/v3/segments/{id}/streams": ["read", "read_all"],
  // Segment efforts
  "GET /api/v3/segment_efforts": ["read"],
  "GET /api/v3/segment_efforts/{id}": ["read"],
  "GET /api/v3/segment_efforts/{id}/streams": ["read_all"],
  // Uploads
  "POST /api/v3/uploads": ["activity:write"],
  "GET /api/v3/uploads/{uploadId}": ["activity:write"],
};

// ── Route owners ────────────────────────────────────────────────────────

interface StravaRouteOwnerOverride {
  readonly permission: string;
  readonly scopes: readonly string[];
}

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const ACTIVITY_READ_SCOPES = ["activity:read", "activity:read_all"] as const;
const READ_ALL_SCOPES = ["read", "read_all"] as const;

const STRAVA_ROUTE_OWNER_OVERRIDES = new Map<string, StravaRouteOwnerOverride>([
  [
    "GET /api/v3/activities/{id}",
    { permission: "activities:read", scopes: ACTIVITY_READ_SCOPES },
  ],
  [
    "GET /api/v3/activities/{id}/comments",
    { permission: "activities:read", scopes: ACTIVITY_READ_SCOPES },
  ],
  [
    "GET /api/v3/activities/{id}/kudos",
    { permission: "activities:read", scopes: ACTIVITY_READ_SCOPES },
  ],
  [
    "GET /api/v3/activities/{id}/laps",
    { permission: "activities:read", scopes: ACTIVITY_READ_SCOPES },
  ],
  [
    "GET /api/v3/activities/{id}/streams",
    { permission: "activities:read", scopes: ACTIVITY_READ_SCOPES },
  ],
  [
    "GET /api/v3/activities/{id}/zones",
    { permission: "activities:read", scopes: ACTIVITY_READ_SCOPES },
  ],
  [
    "GET /api/v3/athlete/activities",
    { permission: "activities:read", scopes: ACTIVITY_READ_SCOPES },
  ],
  [
    "GET /api/v3/athlete",
    { permission: "profile:read", scopes: ["profile:read_all", "read"] },
  ],
  [
    "GET /api/v3/athletes/{id}/routes",
    { permission: "routes:read", scopes: READ_ALL_SCOPES },
  ],
  [
    "GET /api/v3/routes/{id}",
    { permission: "routes:read", scopes: READ_ALL_SCOPES },
  ],
  [
    "GET /api/v3/routes/{id}/export_gpx",
    { permission: "routes:read", scopes: READ_ALL_SCOPES },
  ],
  [
    "GET /api/v3/routes/{id}/export_tcx",
    { permission: "routes:read", scopes: READ_ALL_SCOPES },
  ],
  [
    "GET /api/v3/routes/{id}/streams",
    { permission: "routes:read", scopes: READ_ALL_SCOPES },
  ],
  [
    "GET /api/v3/segments/starred",
    { permission: "segments:read", scopes: READ_ALL_SCOPES },
  ],
  [
    "GET /api/v3/segments/{id}",
    { permission: "segments:read", scopes: READ_ALL_SCOPES },
  ],
  [
    "GET /api/v3/segments/{id}/streams",
    { permission: "segments:read", scopes: READ_ALL_SCOPES },
  ],
]);

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right);
  });
}

function formatScopes(scopes: readonly string[]): string {
  return scopes.join(", ");
}

export function pickStravaPermissionOwners(
  rule: string,
  scopes: readonly string[],
): readonly string[] {
  const uniqueScopes = uniqueSorted(scopes);
  const override = STRAVA_ROUTE_OWNER_OVERRIDES.get(rule);
  if (!override) {
    return uniqueScopes;
  }

  const expectedScopes = uniqueSorted(override.scopes);
  const matchesExpected =
    uniqueScopes.length === expectedScopes.length &&
    uniqueScopes.every((scope, index) => {
      return scope === expectedScopes[index];
    });

  if (!matchesExpected) {
    throw new Error(
      `Strava route "${rule}" owner override scopes changed: expected [${formatScopes(
        expectedScopes,
      )}], got [${formatScopes(uniqueScopes)}]`,
    );
  }

  return [override.permission];
}

function expandRuntimeRule(rule: string): string[] {
  const spaceIndex = rule.indexOf(" ");
  const method = rule.slice(0, spaceIndex);
  const path = rule.slice(spaceIndex + 1);
  if (method !== "ANY") return [rule];
  return RUNTIME_METHODS.map((runtimeMethod) => {
    return `${runtimeMethod} ${path}`;
  });
}

function assertUniqueStravaRules(
  permissions: readonly PermissionGroup[],
): void {
  const owners = new Map<string, string>();
  const duplicates: string[] = [];

  for (const permission of permissions) {
    for (const rule of permission.rules) {
      for (const runtimeRule of expandRuntimeRule(rule)) {
        const existing = owners.get(runtimeRule);
        if (existing) {
          duplicates.push(`${runtimeRule}: ${existing}, ${permission.name}`);
          continue;
        }
        owners.set(runtimeRule, permission.name);
      }
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      "Strava generated duplicate firewall route owners:\n" +
        duplicates
          .sort((left, right) => {
            return left.localeCompare(right);
          })
          .map((duplicate) => {
            return `  - ${duplicate}`;
          })
          .join("\n"),
    );
  }
}

function assertStravaRouteOwnerOverridesMapped(): void {
  const staleOverrides = [...STRAVA_ROUTE_OWNER_OVERRIDES.keys()].filter(
    (rule) => !(rule in SCOPE_MAP),
  );
  if (staleOverrides.length === 0) return;

  throw new Error(
    "Strava route owner overrides without SCOPE_MAP entries:\n" +
      staleOverrides
        .sort((left, right) => {
          return left.localeCompare(right);
        })
        .map((rule) => {
          return `  - ${rule}`;
        })
        .join("\n"),
  );
}

// ── Grouping ─────────────────────────────────────────────────────────────

function buildGroups(spec: SwaggerSpec): {
  permissions: PermissionGroup[];
  unmapped: string[];
} {
  assertStravaRouteOwnerOverridesMapped();

  const basePath = spec.basePath ?? "";
  const groups = new Map<string, Set<string>>();
  const unmapped: string[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (!ALL_METHODS.has(method)) continue;

      const httpMethod = method.toUpperCase();
      const fullPath = stripQueryFragment(`${basePath}${path}`);
      const rule = `${httpMethod} ${fullPath}`;

      const scopes = SCOPE_MAP[rule];
      if (!scopes) {
        unmapped.push(rule);
        continue;
      }

      const owners = pickStravaPermissionOwners(rule, scopes);
      for (const permission of owners) {
        let ruleSet = groups.get(permission);
        if (!ruleSet) {
          ruleSet = new Set();
          groups.set(permission, ruleSet);
        }
        ruleSet.add(rule);
      }
    }
  }

  const permissions = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      rules: sanitizeAndSortRules([...ruleSet]),
    }));

  assertUniqueStravaRules(permissions);

  return { permissions, unmapped };
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from Strava's official Swagger spec.",
    `// Source: ${SPEC_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:strava",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const stravaFirewall = {",
    '  name: "strava",',
    '  description: "Strava API",',
    "  placeholders: {",
    `    STRAVA_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://www.strava.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.STRAVA_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  lines.push(...renderPermissions(permissions));

  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  const res = await fetchSpec(SPEC_URL, "Strava Swagger spec");
  const json: unknown = await res.json();
  if (
    typeof json !== "object" ||
    json === null ||
    !("paths" in json) ||
    typeof (json as SwaggerSpec).paths !== "object"
  ) {
    throw new Error("Invalid Swagger spec: missing paths");
  }
  const spec = json as SwaggerSpec;

  const pathCount = Object.keys(spec.paths ?? {}).length;
  console.error(`  ${pathCount} paths`);

  const { permissions, unmapped } = buildGroups(spec);

  if (unmapped.length > 0) {
    console.error(
      `\n  ${unmapped.length} unmapped endpoints (add to SCOPE_MAP):`,
    );
    for (const ep of unmapped.sort()) {
      console.error(`    "${ep}": [],`);
    }
    throw new Error(
      `${unmapped.length} unmapped endpoints found.\n` +
        "Add them to SCOPE_MAP in strava.ts to fix this error.",
    );
  }

  // Verify all SCOPE_MAP entries match spec endpoints
  const specRules = new Set<string>();
  const basePath = spec.basePath ?? "";
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (!ALL_METHODS.has(method)) continue;
      specRules.add(
        `${method.toUpperCase()} ${stripQueryFragment(`${basePath}${path}`)}`,
      );
    }
  }
  const staleEntries = Object.keys(SCOPE_MAP).filter(
    (rule) => !specRules.has(rule),
  );
  if (staleEntries.length > 0) {
    console.error(`\n  ${staleEntries.length} stale SCOPE_MAP entries:`);
    for (const ep of staleEntries.sort()) {
      console.error(`    "${ep}"`);
    }
    throw new Error(
      `${staleEntries.length} stale SCOPE_MAP entries found.\n` +
        "Remove them from SCOPE_MAP in strava.ts to fix this error.",
    );
  }

  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("strava", ts, import.meta.dirname);
}
