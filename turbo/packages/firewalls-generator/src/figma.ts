/**
 * Generate Figma firewall config from the official OpenAPI spec.
 *
 * Data source: https://github.com/figma/rest-api-spec
 * (Official OpenAPI 3.1.0 spec from Figma.)
 *
 * Permission groups are derived from OAuth 2.0 scopes annotated
 * on each endpoint in the spec's security requirements.
 * Endpoints without OAuth2 security are skipped.
 */

import { parse as parseYaml } from "yaml";

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiOperation, OpenApiSpec, PermissionGroup } from "./codegen";

const OPENAPI_URL =
  "https://raw.githubusercontent.com/figma/rest-api-spec/main/openapi/openapi.yaml";

// Figma personal access token placeholder.
// Format: figd_[A-Za-z0-9_-]{40} (45 chars total)
const PLACEHOLDER_VALUE = "figd_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafe";

const OAUTH_SCHEME_KEYS = new Set(["OAuth2", "OrgOAuth2"]);
const LEGACY_BROAD_SCOPES = new Set(["files:read"]);

// ── Grouping ─────────────────────────────────────────────────────────────

interface FigmaScopePriority {
  readonly isGranular: boolean;
}

function figmaScopePriority(scope: string): FigmaScopePriority {
  return {
    isGranular: !LEGACY_BROAD_SCOPES.has(scope),
  };
}

function compareFigmaScopePriority(
  left: FigmaScopePriority,
  right: FigmaScopePriority,
): number {
  if (left.isGranular !== right.isGranular) {
    return left.isGranular ? 1 : -1;
  }
  return 0;
}

export function pickPrimaryFigmaScope(
  scopes: readonly string[],
  rule: string,
): string {
  const uniqueScopes = [...new Set(scopes)];
  if (uniqueScopes.length === 0) {
    throw new Error(`No Figma scopes available for ${rule}`);
  }
  if (uniqueScopes.length === 1) {
    return uniqueScopes[0]!;
  }

  const ranked = uniqueScopes
    .map((scope) => {
      return { scope, priority: figmaScopePriority(scope) };
    })
    .sort((left, right) => {
      const priorityDifference = compareFigmaScopePriority(
        right.priority,
        left.priority,
      );
      if (priorityDifference !== 0) return priorityDifference;
      return left.scope.localeCompare(right.scope);
    });

  const first = ranked[0];
  if (!first) {
    throw new Error(`No Figma scopes available for ${rule}`);
  }

  const second = ranked[1];
  if (
    second &&
    compareFigmaScopePriority(first.priority, second.priority) === 0
  ) {
    throw new Error(
      `Ambiguous Figma scope owner for ${rule}: ${uniqueScopes.join(", ")}`,
    );
  }

  return first.scope;
}

function assertUniqueFigmaRules(permissions: readonly PermissionGroup[]): void {
  const owners = new Map<string, string>();
  const duplicates: string[] = [];

  for (const permission of permissions) {
    for (const rule of permission.rules) {
      const existing = owners.get(rule);
      if (existing) {
        duplicates.push(`${rule}: ${existing}, ${permission.name}`);
        continue;
      }
      owners.set(rule, permission.name);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      "Figma generated duplicate firewall route owners:\n" +
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

function buildGroups(spec: OpenApiSpec): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  if (!spec.paths) {
    throw new Error("OpenAPI spec has no 'paths'");
  }

  for (const [apiPath, methods] of Object.entries(spec.paths)) {
    for (const [methodLower, op] of Object.entries(methods)) {
      if (typeof op !== "object" || op === null) continue;
      if (!ALL_METHODS.has(methodLower)) {
        if (OPENAPI_PATH_KEYS.has(methodLower) || methodLower.startsWith("x-"))
          continue;
        throw new Error(`Unexpected key '${methodLower}' on ${apiPath}`);
      }

      const operation: OpenApiOperation = op;
      const security = operation.security ?? [];
      const oauthScopes = new Set<string>();
      for (const s of security) {
        for (const [scheme, scopes] of Object.entries(s)) {
          if (OAUTH_SCHEME_KEYS.has(scheme)) {
            for (const scope of scopes) {
              oauthScopes.add(scope);
            }
          }
        }
      }

      if (oauthScopes.size === 0) continue;

      const rule = `${methodLower.toUpperCase()} ${apiPath}`;
      const primaryScope = pickPrimaryFigmaScope([...oauthScopes], rule);
      let ruleSet = groups.get(primaryScope);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(primaryScope, ruleSet);
      }
      ruleSet.add(rule);
    }
  }

  // Get scope descriptions from OAuth2 security schemes
  const scopeDescs = new Map<string, string>();
  for (const key of OAUTH_SCHEME_KEYS) {
    const scopes =
      spec.components?.securitySchemes?.[key]?.flows?.authorizationCode
        ?.scopes ?? {};
    for (const [scope, desc] of Object.entries(scopes)) {
      if (!scopeDescs.has(scope)) {
        scopeDescs.set(scope, desc);
      }
    }
  }

  const permissions = [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      description: scopeDescs.get(name) ?? "",
      rules: sanitizeAndSortRules([...ruleSet]),
    }));
  assertUniqueFigmaRules(permissions);
  return permissions;
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from Figma's official OpenAPI spec.",
    "// Source: https://github.com/figma/rest-api-spec",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:figma",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const figmaFirewall = {",
    '  name: "figma",',
    '  description: "Figma API",',
    "  placeholders: {",
    `    FIGMA_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.figma.com",',
    "      auth: {",
    "        headers: {",
    '          "X-Figma-Token": "${{ secrets.FIGMA_TOKEN }}",',
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
  const res = await fetchSpec(OPENAPI_URL, "Figma OpenAPI spec");
  const text = await res.text();
  const spec = parseYaml(text) as OpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissions = buildGroups(spec);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("figma", ts, import.meta.dirname);
}
