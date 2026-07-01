/**
 * Generate Dropbox firewall config from the official Stone API spec.
 *
 * Data source: https://github.com/dropbox/dropbox-api-spec
 *
 * Dropbox defines its API using Stone (a custom IDL). Each route declares
 * a `scope` attribute that maps directly to Dropbox OAuth scopes
 * (e.g. "files.content.read", "sharing.write"). Routes also declare a
 * `host` attribute ("api", "content", or "notify") — defaults to "api".
 *
 * All Dropbox API calls use POST. The endpoint path is /2/{namespace}/{route}.
 *
 * Routes without a scope (auth/health-check endpoints) are skipped.
 * Unknown scopeless routes cause a build error.
 */

import {
  applyPermissionDescriptions,
  listCachedSpecs,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

const PLACEHOLDER_VALUE =
  "sl.CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafe";

// ── Stone parsing ────────────────────────────────────────────────────────

type DropboxHost = "api" | "content" | "notify";

interface StoneRoute {
  namespace: string;
  name: string;
  scope: string | null;
  host: DropboxHost;
}

// Routes without scopes that are expected (auth/health-check).
// Unknown scopeless routes cause a build error.
const SCOPELESS_ROUTES = new Set([
  "auth/token/revoke",
  "auth/token/from_oauth1",
  "check/app",
]);

const ROUTE_PERMISSION_OVERRIDES: Readonly<Record<string, string>> = {
  // Dropbox labels this mutating admin route as members.read in Stone.
  "team/member_space_limits/set_custom_quota": "members.write",
};

const DROPBOX_PERMISSION_DESCRIPTIONS = {
  "account_info.read":
    "Read Dropbox account profile, account IDs, and linked account metadata.",
  "account_info.write": "Update the current Dropbox account profile photo.",
  "contacts.write": "Delete manually added Dropbox contacts.",
  "events.read": "Read Dropbox team event log entries.",
  "file_requests.read": "List, retrieve, and count Dropbox file requests.",
  "file_requests.write": "Create, update, and delete Dropbox file requests.",
  "files.content.read":
    "Download, export, preview, and read Dropbox file content.",
  "files.content.write":
    "Create, upload, move, copy, lock, and delete Dropbox files and folders.",
  "files.metadata.read":
    "Read Dropbox file, folder, tag, and property metadata.",
  "files.metadata.write":
    "Create, update, and remove Dropbox file tags, templates, and custom properties.",
  "files.permanent_delete":
    "Permanently delete Dropbox files, folders, and Paper docs.",
  "files.team_metadata.write":
    "Create, update, and remove team file property templates and metadata.",
  "groups.read": "Read Dropbox team groups and group memberships.",
  "groups.write":
    "Create, update, delete, and manage Dropbox team groups and group members.",
  "members.delete":
    "Remove, recover, and complete deletion workflows for Dropbox team members.",
  "members.read":
    "Read Dropbox team member profiles, roles, quotas, and membership state.",
  "members.write":
    "Add, update, suspend, unsuspend, and manage Dropbox team members and member quotas.",
  openid: "Read OpenID Connect identity information from Dropbox.",
  "private:sharing.write":
    "Relinquish the current user's removable access to files and folders.",
  "sessions.list":
    "List Dropbox team member devices, web sessions, and linked apps.",
  "sessions.modify":
    "Revoke Dropbox team member devices, web sessions, and linked apps.",
  "sharing.read":
    "Read Dropbox shared links, shared files, shared folders, and membership details.",
  "sharing.write":
    "Create, update, revoke, mount, unmount, and manage Dropbox sharing.",
  "team_data.content.read":
    "Read Dropbox team folders, namespaces, and team-owned content metadata.",
  "team_data.content.write":
    "Create, rename, activate, archive, restore, and delete Dropbox team folders.",
  "team_data.governance.write":
    "Create, update, release, and inspect Dropbox team legal hold policies and held revisions.",
  "team_data.member":
    "List Dropbox team namespaces and member folder structure.",
  "team_info.read":
    "Read Dropbox team profile, features, reports, and team settings.",
  "team_info.write": "Update Dropbox team-level sharing allowlist settings.",
} satisfies Readonly<Record<string, string>>;

function parseStoneRoutes(content: string): StoneRoute[] {
  const routes: StoneRoute[] = [];
  const lines = content.split("\n");

  let namespace = "";
  let currentRoute = "";
  let inAttrs = false;
  let routeScope: string | null = null;
  let routeHost: DropboxHost = "api";

  function flushRoute(): void {
    if (currentRoute) {
      routes.push({
        namespace,
        name: currentRoute,
        scope: routeScope,
        host: routeHost,
      });
      currentRoute = "";
      routeScope = null;
      routeHost = "api";
      inAttrs = false;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    const nsCapture = /^namespace\s+(\S+)/.exec(trimmed)?.[1];
    if (nsCapture) {
      namespace = nsCapture;
      continue;
    }

    const routeCapture = /^route\s+(\S+)\s*\(/.exec(trimmed)?.[1];
    if (routeCapture) {
      flushRoute();
      currentRoute = routeCapture;
      continue;
    }

    if (trimmed === "attrs") {
      inAttrs = true;
      continue;
    }

    if (inAttrs && currentRoute) {
      const scopeCapture = /^scope\s*=\s*"([^"]+)"/.exec(trimmed)?.[1];
      if (scopeCapture) {
        routeScope = scopeCapture;
      }
      const hostCapture = /^host\s*=\s*"([^"]+)"/.exec(trimmed)?.[1];
      if (
        hostCapture === "api" ||
        hostCapture === "content" ||
        hostCapture === "notify"
      ) {
        routeHost = hostCapture;
      }
    }
  }
  flushRoute();

  return routes;
}

// ── Grouping ─────────────────────────────────────────────────────────────

const HOST_BASE_URLS: Record<DropboxHost, string> = {
  api: "https://api.dropboxapi.com",
  content: "https://content.dropboxapi.com",
  notify: "https://notify.dropboxapi.com",
};

interface HostPermissions {
  permissions: PermissionGroup[];
}

function buildGroups(routes: StoneRoute[]): Map<DropboxHost, HostPermissions> {
  // scope -> host -> rules
  const groups = new Map<string, Map<string, Set<string>>>();
  const unknownScopeless: string[] = [];

  for (const route of routes) {
    const fullName = `${route.namespace}/${route.name}`;

    if (!route.scope) {
      if (!SCOPELESS_ROUTES.has(fullName)) {
        unknownScopeless.push(fullName);
      }
      continue;
    }

    const rule = `POST /2/${fullName}`;
    const permissionName = ROUTE_PERMISSION_OVERRIDES[fullName] ?? route.scope;

    let hostMap = groups.get(permissionName);
    if (!hostMap) {
      hostMap = new Map();
      groups.set(permissionName, hostMap);
    }
    let ruleSet = hostMap.get(route.host);
    if (!ruleSet) {
      ruleSet = new Set();
      hostMap.set(route.host, ruleSet);
    }
    ruleSet.add(rule);
  }

  if (unknownScopeless.length > 0) {
    throw new Error(
      `Unknown scopeless routes: ${unknownScopeless.join(", ")}\n` +
        "Add them to SCOPELESS_ROUTES in dropbox.ts to fix this error.",
    );
  }

  // Build per-host permission groups
  const result = new Map<DropboxHost, HostPermissions>();

  for (const host of Object.keys(HOST_BASE_URLS) as DropboxHost[]) {
    const permissions: PermissionGroup[] = [];

    for (const [scope, hostMap] of [...groups.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const ruleSet = hostMap.get(host);
      if (!ruleSet || ruleSet.size === 0) continue;

      permissions.push({
        name: scope,
        rules: sanitizeAndSortRules([...ruleSet]),
      });
    }

    result.set(host, { permissions });
  }

  return result;
}

function allPermissionGroups(
  hostGroups: Map<DropboxHost, HostPermissions>,
): PermissionGroup[] {
  const permissionsByName = new Map<string, PermissionGroup>();

  for (const { permissions } of hostGroups.values()) {
    for (const permission of permissions) {
      const existing = permissionsByName.get(permission.name);
      if (existing) {
        existing.rules.push(...permission.rules);
        continue;
      }
      permissionsByName.set(permission.name, {
        name: permission.name,
        rules: [...permission.rules],
      });
    }
  }

  return [...permissionsByName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function applyDropboxPermissionDescriptions(
  hostGroups: Map<DropboxHost, HostPermissions>,
): Map<DropboxHost, HostPermissions> {
  const describedPermissions = applyPermissionDescriptions(
    "Dropbox",
    allPermissionGroups(hostGroups),
    DROPBOX_PERMISSION_DESCRIPTIONS,
  );
  const descriptions = new Map(
    describedPermissions.map((permission) => {
      return [permission.name, permission.description] as const;
    }),
  );

  return new Map(
    [...hostGroups.entries()].map(([host, { permissions }]) => {
      return [
        host,
        {
          permissions: permissions.map((permission) => {
            const description = descriptions.get(permission.name);
            if (!description) {
              throw new Error(
                `Missing Dropbox permission description after validation: ${permission.name}`,
              );
            }
            return {
              ...permission,
              description,
            };
          }),
        },
      ];
    }),
  );
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(
  hostGroups: Map<DropboxHost, HostPermissions>,
): string {
  const lines: string[] = [
    "// Auto-generated from Dropbox's official Stone API spec.",
    "// Source: https://github.com/dropbox/dropbox-api-spec",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:dropbox",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const dropboxFirewall = {",
    '  name: "dropbox",',
    '  description: "Dropbox API",',
    "  placeholders: {",
    `    DROPBOX_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
  ];

  for (const [host, { permissions }] of hostGroups) {
    const baseUrl = HOST_BASE_URLS[host];
    lines.push("    {");
    lines.push(`      base: "${baseUrl}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      '          Authorization: "Bearer ${{ secrets.DROPBOX_TOKEN }}",',
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

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  const cachedSpecs = listCachedSpecs("dropbox");
  console.error(`  Loading ${cachedSpecs.length} cached .stone files`);

  const allRoutes = cachedSpecs.flatMap(({ content }) =>
    parseStoneRoutes(content),
  );
  console.error(`  Parsed ${allRoutes.length} routes`);

  const hostGroups = applyDropboxPermissionDescriptions(buildGroups(allRoutes));
  const ts = generateTypeScript(hostGroups);

  // Log stats for the main API host
  const apiPerms = hostGroups.get("api")?.permissions ?? [];
  const contentPerms = hostGroups.get("content")?.permissions ?? [];
  const notifyPerms = hostGroups.get("notify")?.permissions ?? [];
  const allPerms = [...apiPerms, ...contentPerms, ...notifyPerms];
  logStats(allPerms);
  writeOutput("dropbox", ts);
}
