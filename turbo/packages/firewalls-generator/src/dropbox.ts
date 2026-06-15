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

    let hostMap = groups.get(route.scope);
    if (!hostMap) {
      hostMap = new Map();
      groups.set(route.scope, hostMap);
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

  const hostGroups = buildGroups(allRoutes);
  const ts = generateTypeScript(hostGroups);

  // Log stats for the main API host
  const apiPerms = hostGroups.get("api")?.permissions ?? [];
  const contentPerms = hostGroups.get("content")?.permissions ?? [];
  const notifyPerms = hostGroups.get("notify")?.permissions ?? [];
  const allPerms = [...apiPerms, ...contentPerms, ...notifyPerms];
  logStats(allPerms);
  writeOutput("dropbox", ts, import.meta.dirname);
}
