/**
 * Generate Axiom firewall config from official OpenAPI specs.
 *
 * Data source: https://axiom.co/docs/restapi/versions/
 *
 * Axiom publishes four OpenAPI specs (v2, v1, v1-edge-query, v1-edge-ingest).
 * Each endpoint declares required scopes in the `security` field using the
 * `Auth` scheme with `resource|action` format (e.g. "annotations|read").
 *
 * The v1 spec uses legacy scope names (CanIngest, CanQuery, ManageDatasets)
 * which are mapped to the modern format.
 *
 * Endpoints without scopes either need a manual scope in SCOPE_OVERRIDES or
 * explicit tracking in SCOPELESS_ENDPOINTS — unknown entries fail generation.
 */

import {
  ALL_METHODS,
  applyPermissionDescriptions,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

const SPEC_URLS = [
  "https://axiom.co/docs/restapi/versions/v2.json",
  "https://axiom.co/docs/restapi/versions/v1.json",
  "https://axiom.co/docs/restapi/versions/v1-edge-query.json",
  "https://axiom.co/docs/restapi/versions/v1-edge-ingest.json",
];

// Format: xaat- prefix + UUID (8-4-4-4-12 hex) = 41 total
const PLACEHOLDER_VALUE = "xaat-c0ffee5a-fe10-ca1c-0ffe-e5afe10ca1c0";

const AXIOM_SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "annotations|create": "Create Axiom annotations.",
  "annotations|delete": "Delete Axiom annotations.",
  "annotations|read": "Read Axiom annotations.",
  "annotations|update": "Update Axiom annotations.",
  "apiTokens|create": "Create Axiom API tokens.",
  "apiTokens|delete": "Delete Axiom API tokens.",
  "apiTokens|read": "Read Axiom API tokens and token metadata.",
  "apiTokens|update": "Regenerate Axiom API tokens.",
  "dashboards|create": "Create Axiom dashboards.",
  "dashboards|delete": "Delete Axiom dashboards.",
  "dashboards|read": "Read Axiom dashboards.",
  "dashboards|update": "Update Axiom dashboards and dashboard charts.",
  "datasets|create": "Create Axiom datasets.",
  "datasets|delete": "Delete Axiom datasets.",
  "datasets|read": "Read Axiom datasets, fields, and map fields.",
  "datasets|update":
    "Create, update, delete, and trim Axiom datasets, fields, and map fields.",
  "ingest|create": "Ingest events into Axiom datasets.",
  "monitors|create": "Create Axiom monitors.",
  "monitors|delete": "Delete Axiom monitors.",
  "monitors|read": "Read Axiom monitors and monitor history.",
  "monitors|update": "Update Axiom monitors.",
  "notifiers|create": "Create Axiom notifiers.",
  "notifiers|delete": "Delete Axiom notifiers.",
  "notifiers|read": "Read Axiom notifiers.",
  "notifiers|update": "Update Axiom notifiers.",
  "orgs|create": "Create Axiom organizations.",
  "orgs|read": "Read Axiom organizations.",
  "orgs|update": "Update Axiom organizations.",
  "query|read": "Run Axiom queries and read query results.",
  "rbac|create": "Create, update, and delete Axiom RBAC groups and roles.",
  "rbac|read": "Read Axiom RBAC groups and roles.",
  "starredQueries|create": "Create Axiom starred queries.",
  "starredQueries|delete": "Delete Axiom starred queries.",
  "starredQueries|read": "Read Axiom starred queries.",
  "starredQueries|update": "Update Axiom starred queries.",
  "trim|update": "Trim data from Axiom datasets.",
  "users|create": "Create Axiom users.",
  "users|delete": "Delete Axiom users.",
  "users|read": "Read Axiom users and current user information.",
  "users|update": "Update Axiom current user information and user roles.",
  "vacuum|update": "Start Axiom dataset vacuum operations.",
  "views|create": "Create Axiom views.",
  "views|delete": "Delete Axiom views.",
  "views|read": "Read Axiom views.",
  "views|update": "Update Axiom views.",
  "virtualFields|create": "Create Axiom virtual fields.",
  "virtualFields|delete": "Delete Axiom virtual fields.",
  "virtualFields|read": "Read Axiom virtual fields.",
  "virtualFields|update": "Update Axiom virtual fields.",
};

// ── OpenAPI types ────────────────────────────────────────────────────────

interface AxiomSpec {
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, AxiomOperation>>;
}

interface AxiomOperation {
  security?: Array<Record<string, string[]>>;
}

// ── Legacy scope mapping ─────────────────────────────────────────────────
// v1 spec uses old scope names — map to modern resource|action format.

const LEGACY_SCOPE_MAP: Record<string, string> = {
  CanIngest: "ingest|create",
  CanQuery: "query|read",
  ManageDatasets: "datasets|update",
};

// ── Missing scope overrides ──────────────────────────────────────────────
// OpenAPI 3.0 Bearer auth schemes cannot annotate per-endpoint scopes,
// so some endpoints appear scopeless in the spec. These overrides supply
// the actual capability required (confirmed via axiom-go SDK + API docs).

const SCOPE_OVERRIDES: Record<string, string> = {
  // datasets list/get require datasets|read
  "GET /v2/datasets": "datasets|read",
  "GET /v2/datasets/{dataset_id}": "datasets|read",
  "GET /v1/datasets": "datasets|read",
  "GET /v1/datasets/{dataset_name}": "datasets|read",
  // dashboards
  "GET /v2/dashboards": "dashboards|read",
  "POST /v2/dashboards": "dashboards|create",
  "GET /v2/dashboards/uid/{uid}": "dashboards|read",
  "PUT /v2/dashboards/uid/{uid}": "dashboards|update",
  "PATCH /v2/dashboards/uid/{uid}/charts/{chartId}": "dashboards|update",
  "DELETE /v2/dashboards/uid/{uid}": "dashboards|delete",
  // orgs
  "GET /v2/orgs": "orgs|read",
  "GET /v2/orgs/{id}": "orgs|read",
  "POST /v2/orgs": "orgs|create",
  "PUT /v2/orgs/{id}": "orgs|update",
  // current user
  "GET /v2/user": "users|read",
  "GET /v1/user": "users|read",
  "PUT /v2/user": "users|update",
};

// ── Scopeless endpoints ──────────────────────────────────────────────────
// Endpoints that genuinely require no specific scope — only a valid token
// or no auth at all. Unknown scopeless endpoints cause a build error.

const SCOPELESS_ENDPOINTS = new Set([
  // CORS preflight — no auth
  "OPTIONS /v1/query/_mpl",
]);

// ── Grouping ─────────────────────────────────────────────────────────────

function extractVersionPrefix(serverUrl: string): string {
  // "https://api.axiom.co/v2/" → "/v2"
  // "https://{axiom-domain}/v1/" → "/v1"
  const match = /\/(v\d+)\/?$/.exec(serverUrl);
  return match?.[1] ? `/${match[1]}` : "";
}

function buildGroups(specs: Array<{ spec: AxiomSpec }>): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  const unknownScopeless: string[] = [];

  for (const { spec } of specs) {
    const versionPrefix = extractVersionPrefix(spec.servers?.[0]?.url ?? "");

    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (!ALL_METHODS.has(method)) continue;

        const httpMethod = method.toUpperCase();
        const fullPath = `${versionPrefix}${path}`;
        const rule = `${httpMethod} ${fullPath}`;

        // Extract scopes from security schemes
        const scopes: string[] = [];
        if (op.security) {
          for (const scheme of op.security) {
            const authScopes = scheme.Auth ?? scheme.Shared ?? [];
            for (const s of authScopes) {
              if (s) {
                const mapped = LEGACY_SCOPE_MAP[s] ?? s;
                scopes.push(mapped);
              }
            }
          }
        }

        // Apply manual overrides for endpoints missing scopes in spec
        const override = SCOPE_OVERRIDES[rule];
        if (override) {
          scopes.push(override);
        }

        if (scopes.length === 0) {
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

  if (unknownScopeless.length > 0) {
    throw new Error(
      `Unknown scopeless endpoints: ${unknownScopeless.join(", ")}\n` +
        "Add scope-bearing endpoints to SCOPE_OVERRIDES, or genuinely unscoped endpoints to SCOPELESS_ENDPOINTS in axiom.ts.",
    );
  }

  return [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      rules: sanitizeAndSortRules([...ruleSet]),
    }));
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from Axiom's official OpenAPI specs.",
    `// Source: ${SPEC_URLS[0]}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:axiom",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const axiomFirewall = {",
    '  name: "axiom",',
    '  description: "Axiom API",',
    "  placeholders: {",
    `    AXIOM_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.axiom.co",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.AXIOM_TOKEN }}",',
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
  const fetched = await Promise.all(
    SPEC_URLS.map(async (url) => {
      const label = url.split("/").pop() ?? url;
      const res = await fetchSpec(url, label);
      const json: unknown = await res.json();
      if (typeof json !== "object" || json === null || !("paths" in json)) {
        throw new Error(`Invalid OpenAPI spec from ${label}: missing paths`);
      }
      const spec = json as AxiomSpec;
      return { spec };
    }),
  );

  const permissions = applyPermissionDescriptions(
    "Axiom",
    buildGroups(fetched),
    AXIOM_SCOPE_DESCRIPTIONS,
  );
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("axiom", ts);
}
