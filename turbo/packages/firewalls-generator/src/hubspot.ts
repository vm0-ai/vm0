/**
 * Generate HubSpot firewall config from official OpenAPI specs.
 *
 * Data source: https://github.com/HubSpot/HubSpot-public-api-spec-collection
 *
 * HubSpot publishes per-API OpenAPI 3.0 specs with OAuth scopes annotated
 * on each operation via the standard `security` field. Scopes follow
 * patterns like `crm.objects.contacts.read`, `content`, `forms`, etc.
 *
 * We fetch the GitHub repo tree, pick the latest rollout per API area,
 * download each spec, and extract scope→endpoint mappings.
 *
 * Endpoints without scopes are tracked in SCOPELESS_ENDPOINTS — unknown
 * scopeless endpoints cause a build error.
 */

import {
  ALL_METHODS,
  fetchSpec,
  logStats,
  renderPermissions,
  sortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

const REPO = "HubSpot/HubSpot-public-api-spec-collection";
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;

const PLACEHOLDER_VALUE = "CoffeeSafeLocalCoffeeSafeLocalCo";

// ── OpenAPI types ────────────────────────────────────────────────────────

interface HubSpotOperation {
  security?: Array<Record<string, string[]>>;
}

interface HubSpotSpec {
  paths?: Record<string, Record<string, HubSpotOperation>>;
}

// ── GitHub tree types ───────────────────────────────────────────────────

interface GitHubTree {
  tree: Array<{ path: string; type: string }>;
}

// ── Spec discovery ──────────────────────────────────────────────────────

/** Parse a spec file path into its components. */
function parseSpecPath(filePath: string): {
  category: string;
  feature: string;
  rolloutId: number;
  version: string;
  fileName: string;
} | null {
  // PublicApiSpecs/{Category}/{Feature}/Rollouts/{RolloutID}/{Version}/{file}.json
  const match =
    /^PublicApiSpecs\/([^/]+)\/([^/]+)\/Rollouts\/(\d+)\/([^/]+)\/([^/]+\.json)$/.exec(
      filePath,
    );
  if (!match) return null;
  const [, category, feature, rolloutIdStr, version, fileName] = match;
  if (!category || !feature || !rolloutIdStr || !version || !fileName) {
    return null;
  }
  return {
    category,
    feature,
    rolloutId: Number(rolloutIdStr),
    version,
    fileName,
  };
}

/** Date-based versions like "2026-03" or "2026-09-beta" should be skipped. */
function isStableVersion(version: string): boolean {
  return /^v\d+$/.test(version);
}

/**
 * From a list of file paths, pick the latest rollout per API area,
 * preferring stable versions (v3, v4) over date-based ones.
 */
function pickLatestSpecs(
  paths: string[],
): Array<{ path: string; feature: string }> {
  // Group: "Category/Feature" -> best spec path
  const best = new Map<
    string,
    { path: string; rolloutId: number; feature: string }
  >();

  for (const p of paths) {
    const parsed = parseSpecPath(p);
    if (!parsed) continue;

    // Skip Collection Directory files
    if (p.includes("Collection Directory")) continue;

    // Prefer stable versions; fall back to date-based if no stable exists
    const key = `${parsed.category}/${parsed.feature}`;
    const existing = best.get(key);

    if (!existing) {
      best.set(key, {
        path: p,
        rolloutId: parsed.rolloutId,
        feature: parsed.feature,
      });
    } else {
      const existingStable = isStableVersion(
        parseSpecPath(existing.path)?.version ?? "",
      );
      const newStable = isStableVersion(parsed.version);

      // Prefer stable over date-based, then higher rollout ID
      if (
        (newStable && !existingStable) ||
        (newStable === existingStable && parsed.rolloutId > existing.rolloutId)
      ) {
        best.set(key, {
          path: p,
          rolloutId: parsed.rolloutId,
          feature: parsed.feature,
        });
      }
    }
  }

  return [...best.values()].map(({ path, feature }) => ({
    path,
    feature,
  }));
}

// ── Scope overrides ──────────────────────────────────────────────────────
// Endpoints without documented scopes that should still be accessible.

const SCOPE_OVERRIDES: Record<string, string> = {
  // Account info — read-only account details
  "GET /account-info/v3/activity/login": "account-info.security.read",
  "GET /account-info/v3/activity/security": "account-info.security.read",
  "GET /account-info/v3/api-usage/daily": "account-info.security.read",
  "GET /account-info/v3/details": "account-info.security.read",
  // Forecast settings — read-only
  "GET /forecast-settings/v3/forecast-types": "crm.objects.goals.read",
  "GET /forecast-settings/v3/forecast-types/{forecastTypeId}":
    "crm.objects.goals.read",
  // CRM contracts (new object type, scopes not yet in spec)
  "GET /crm/v3/objects/contracts": "crm.objects.contacts.read",
  "GET /crm/v3/objects/contracts/{contractId}": "crm.objects.contacts.read",
  "POST /crm/v3/objects/contracts/batch/read": "crm.objects.contacts.read",
  "POST /crm/v3/objects/contracts/search": "crm.objects.contacts.read",
  "POST /crm/v3/objects/contracts": "crm.objects.contacts.write",
  "POST /crm/v3/objects/contracts/batch/create": "crm.objects.contacts.write",
  "POST /crm/v3/objects/contracts/batch/update": "crm.objects.contacts.write",
  "POST /crm/v3/objects/contracts/batch/upsert": "crm.objects.contacts.write",
  "POST /crm/v3/objects/contracts/batch/archive": "crm.objects.contacts.write",
  "PATCH /crm/v3/objects/contracts/{contractId}": "crm.objects.contacts.write",
  "DELETE /crm/v3/objects/contracts/{contractId}": "crm.objects.contacts.write",
  // CRM payments — read-only commerce data
  "GET /crm/v3/objects/payments": "crm.objects.commercepayments.read",
  "GET /crm/v3/objects/payments/{paymentsId}":
    "crm.objects.commercepayments.read",
  "POST /crm/v3/objects/payments/batch/read":
    "crm.objects.commercepayments.read",
  "POST /crm/v3/objects/payments/search": "crm.objects.commercepayments.read",
};

// ── Scopeless endpoints ──────────────────────────────────────────────────
// Endpoints without OAuth scopes that we've reviewed and confirmed are
// correctly denied. Unknown scopeless endpoints cause a build error.

const SCOPELESS_ENDPOINTS = new Set([
  // OAuth token management
  "GET /oauth/authorize",
  "POST /oauth/v1/token",
  "GET /oauth/v1/access-tokens/{token}",
  "GET /oauth/v1/refresh-tokens/{token}",
  "DELETE /oauth/v1/refresh-tokens/{token}",
  "POST /oauth/v3/token",
  "POST /oauth/v3/token/introspect",
  "POST /oauth/v3/token/revoke",
  // CRM extensions (dev-only, no {appId} but still app-level)
  "GET /crm/v3/extensions/cards-dev/sample-response",
  // Conversations custom channels (app-level integration)
  "GET /conversations/custom-channels/v3",
  "GET /conversations/v3/custom-channels/{channelId}",
  "POST /conversations/custom-channels/v3",
  "PATCH /conversations/v3/custom-channels/{channelId}",
  "DELETE /conversations/v3/custom-channels/{channelId}",
  // Meta network origins (public info, no auth needed)
  "GET /meta/network-origins/2025-09/ip-ranges",
  "GET /meta/network-origins/2025-09/ip-ranges/simple",
  "GET /meta/network-origins/2026-03/ip-ranges",
  "GET /meta/network-origins/2026-03/ip-ranges/simple",
]);

// ── Grouping ─────────────────────────────────────────────────────────────

function buildGroups(specs: HubSpotSpec[]): {
  permissions: PermissionGroup[];
  scopeless: string[];
} {
  const groups = new Map<string, Set<string>>();
  const unknownScopeless: string[] = [];

  for (const spec of specs) {
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (!ALL_METHODS.has(method)) continue;

        const httpMethod = method.toUpperCase();
        const rule = `${httpMethod} ${path}`;

        // Extract OAuth scopes from security array
        const scopes: string[] = [];
        if (op.security) {
          for (const req of op.security) {
            const oauthScopes = req["oauth2"];
            if (oauthScopes) {
              scopes.push(...oauthScopes);
            }
          }
        }

        // Apply manual overrides for endpoints missing scopes in spec
        const override = SCOPE_OVERRIDES[rule];
        if (override) {
          scopes.push(override);
        }

        if (scopes.length === 0) {
          // App developer APIs use {appId} and require app-level auth,
          // not user OAuth tokens — silently skip (denied by default).
          if (path.includes("{appId}")) continue;
          if (!SCOPELESS_ENDPOINTS.has(rule)) {
            unknownScopeless.push(rule);
          }
          continue;
        }

        for (const scope of scopes) {
          let ruleSet = groups.get(scope);
          if (!ruleSet) {
            ruleSet = new Set();
            groups.set(scope, ruleSet);
          }
          ruleSet.add(rule);
        }
      }
    }
  }

  const permissions = [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      rules: sortRules([...ruleSet]),
    }));

  return { permissions, scopeless: unknownScopeless };
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    `// Auto-generated from HubSpot's official OpenAPI specs.`,
    `// Source: https://github.com/${REPO}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:hubspot",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../contracts/firewalls";',
    "",
    "export const hubspotFirewall = {",
    '  name: "hubspot",',
    '  description: "HubSpot API",',
    "  placeholders: {",
    `    HUBSPOT_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.hubapi.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.HUBSPOT_TOKEN }}",',
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
  console.error("Fetching HubSpot spec file tree…");
  const treeRes = await fetch(TREE_URL, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!treeRes.ok) {
    throw new Error(`Failed to fetch repo tree: ${treeRes.status}`);
  }
  const tree: unknown = await treeRes.json();
  if (
    typeof tree !== "object" ||
    tree === null ||
    !("tree" in tree) ||
    !Array.isArray((tree as GitHubTree).tree)
  ) {
    throw new Error("Invalid GitHub tree response");
  }
  const { tree: entries } = tree as GitHubTree;

  const jsonPaths = entries
    .filter(
      (e) =>
        e.type === "blob" &&
        e.path.startsWith("PublicApiSpecs/") &&
        e.path.endsWith(".json") &&
        !e.path.includes("Collection Directory"),
    )
    .map((e) => e.path);

  const specEntries = pickLatestSpecs(jsonPaths);
  console.error(`  Found ${specEntries.length} API specs`);

  // Download all specs in parallel
  const specs = await Promise.all(
    specEntries.map(async ({ path, feature }) => {
      const url = `${RAW_BASE}/${path}`;
      const res = await fetchSpec(url, feature);
      const json: unknown = await res.json();
      if (
        typeof json !== "object" ||
        json === null ||
        !("paths" in json) ||
        typeof (json as HubSpotSpec).paths !== "object"
      ) {
        console.error(`  Skipping ${feature}: no paths`);
        return null;
      }
      return json as HubSpotSpec;
    }),
  );

  const validSpecs = specs.filter((s): s is HubSpotSpec => s !== null);
  console.error(`  Parsed ${validSpecs.length} specs`);

  const { permissions, scopeless } = buildGroups(validSpecs);

  if (scopeless.length > 0) {
    console.error(
      `\n  ${scopeless.length} endpoints without scopes (add to SCOPELESS_ENDPOINTS):`,
    );
    for (const ep of scopeless.sort()) {
      console.error(`    "${ep}",`);
    }
    throw new Error(
      `${scopeless.length} unknown scopeless endpoints found.\n` +
        "Add them to SCOPELESS_ENDPOINTS in hubspot.ts to fix this error.",
    );
  }

  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("hubspot", ts, import.meta.dirname);
}
