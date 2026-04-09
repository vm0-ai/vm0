/**
 * Shared codegen utilities for firewall config generators.
 *
 * Provides common types, rule sorting, TypeScript rendering helpers,
 * and file I/O used by all individual firewall generators.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Placeholder host for webhook-url connectors whose credentials are
 * embedded in the URL path. DNS resolves to a routable address so the
 * transparent proxy can intercept and rewrite the URL at runtime.
 */
export const FIREWALL_PLACEHOLDER_HOST = "firewall-placeholder.vm3.ai";

// ── Types ────────────────────────────────────────────────────────────────

export interface PermissionGroup {
  name: string;
  description?: string;
  rules: string[];
}

// ── OpenAPI types ────────────────────────────────────────────────────────

export interface OpenApiOperation {
  security?: Array<Record<string, string[]>>;
}

type OpenApiPathItem = Record<string, unknown>;

export interface OpenApiSpec {
  info?: { version?: string };
  paths?: Record<string, OpenApiPathItem>;
  components?: {
    securitySchemes?: {
      [key: string]: {
        flows?: {
          authorizationCode?: {
            scopes?: Record<string, string>;
          };
        };
      };
    };
  };
}

export const ALL_METHODS = new Set([
  "get",
  "head",
  "post",
  "put",
  "patch",
  "delete",
]);

export const OPENAPI_PATH_KEYS = new Set([
  "summary",
  "description",
  "servers",
  "parameters",
  "$ref",
  "options",
  "trace",
]);

// ── Path sanitization ────────────────────────────────────────────────────

/**
 * Strip query string (`?…`) and fragment (`#…`) from an OpenAPI path.
 * Some specs include these in path keys; firewall rules must not contain them.
 */
export function stripQueryFragment(p: string): string {
  const qIdx = p.indexOf("?");
  const hIdx = p.indexOf("#");
  if (qIdx === -1 && hIdx === -1) return p;
  const cutIdx = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
  return p.slice(0, cutIdx);
}

// ── Rule sorting ─────────────────────────────────────────────────────────

const METHOD_ORDER: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
};

function ruleKey(rule: string): [string, number] {
  const [method, rulePath] = rule.split(" ", 2) as [string, string];
  return [rulePath, METHOD_ORDER[method] ?? 9];
}

/**
 * Sanitize a rule by stripping query strings / fragments from its path.
 * e.g. `"POST /v1/datasets/_apl?format=tabular"` → `"POST /v1/datasets/_apl"`
 */
function sanitizeRule(rule: string): string {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx === -1) return rule;
  const method = rule.slice(0, spaceIdx);
  const rest = rule.slice(spaceIdx + 1);
  const cleaned = stripQueryFragment(rest);
  if (cleaned !== rest) {
    console.error(
      `  ⚠ Stripped query/fragment from rule: "${rule}" → "${method} ${cleaned}"`,
    );
  }
  return `${method} ${cleaned}`;
}

/**
 * Sanitize, deduplicate, and sort firewall rules.
 *
 * - Strips query strings / fragments that some OpenAPI specs include in path keys
 * - Deduplicates rules that collapse after stripping
 * - Sorts by path then HTTP method order
 */
export function sanitizeAndSortRules(rules: string[]): string[] {
  return [...new Set(rules.map(sanitizeRule))].sort((a, b) => {
    const [pathA, orderA] = ruleKey(a);
    const [pathB, orderB] = ruleKey(b);
    return pathA < pathB ? -1 : pathA > pathB ? 1 : orderA - orderB;
  });
}

// ── String escaping ──────────────────────────────────────────────────────

export function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── TypeScript rendering ─────────────────────────────────────────────────

/**
 * Render permission entries as indented TypeScript source lines for
 * embedding in an `apis[].permissions` array.
 */
export function renderPermissions(permissions: PermissionGroup[]): string[] {
  const lines: string[] = [];

  for (const perm of permissions) {
    lines.push("        {");
    lines.push(`          name: "${escapeString(perm.name)}",`);
    if (perm.description) {
      lines.push(`          description: "${escapeString(perm.description)}",`);
    }
    lines.push("          rules: [");
    for (const rule of perm.rules) {
      lines.push(`            "${escapeString(rule)}",`);
    }
    lines.push("          ],");
    lines.push("        },");
  }

  return lines;
}

// ── Default policies ────────────────────────────────────────────────────

/**
 * Render a default-allowed permissions export as a const array.
 * Permissions NOT in this list are denied by default.
 *
 * @param varName - Export variable name (e.g. "slackDefaultAllowed")
 * @param firewallVar - The firewall config variable for type checking
 * @param allowed - Permission names that are allowed by default
 */
export function renderDefaultAllowed(
  varName: string,
  firewallVar: string,
  allowed: string[],
): string[] {
  const lines: string[] = [
    "",
    `export const ${varName}: ReadonlyArray<`,
    `  PermissionNamesOf<typeof ${firewallVar}>`,
    "> = [",
  ];
  for (const name of allowed) {
    lines.push(`  "${escapeString(name)}",`);
  }
  lines.push("];");
  lines.push("");
  return lines;
}

// ── File I/O ─────────────────────────────────────────────────────────────

/**
 * Write generated content to the output file and validate it's non-empty.
 *
 * @param serviceName - Used to derive the output filename
 *   (e.g. "figma" → "figma.generated.ts")
 * @param content - Generated TypeScript source
 * @param dirname - `import.meta.dirname` of the calling module
 */
export function writeOutput(
  serviceName: string,
  content: string,
  dirname: string,
): void {
  const outPath = path.resolve(
    dirname,
    `../../core/src/firewalls/${serviceName}.generated.ts`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
  console.error(`  Written to ${outPath}`);

  const stat = fs.statSync(outPath);
  if (stat.size === 0) {
    throw new Error("Generated file is empty");
  }
  console.error(`  Validated (${(stat.size / 1024).toFixed(1)} KB)`);
}

// ── Logging ──────────────────────────────────────────────────────────────

export function logStats(permissions: PermissionGroup[]): void {
  const totalRules = permissions.reduce((sum, p) => sum + p.rules.length, 0);
  console.error(
    `  ${permissions.length} permission groups, ${totalRules} rules`,
  );
}

// ── HTTP ─────────────────────────────────────────────────────────────────

/**
 * Fetch a URL with error handling. Throws on non-OK responses.
 */
export async function fetchSpec(url: string, label: string): Promise<Response> {
  console.error(`Downloading ${label}…`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${label}: ${res.status} ${res.statusText}`,
    );
  }
  return res;
}
