/**
 * Generate Notion firewall config from the official OpenAPI spec.
 *
 * Data source: https://developers.notion.com/openapi.json
 * (Official OpenAPI 3.1.0 spec from Notion.)
 *
 * Permission groups are derived from Notion's "capabilities" model:
 * read_content, update_content, insert_content, read_comments,
 * insert_comments, read_users.
 *
 * Capability assignment uses a deterministic tag + HTTP method mapping,
 * matching Notion's documented capability requirements. OAuth endpoints
 * are excluded (not behind capabilities).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const OPENAPI_URL = "https://developers.notion.com/openapi.json";

// Notion integration token placeholder.
// Format: ntn_[0-9]{11}[A-Za-z0-9]{35} (50 chars total)
const PLACEHOLDER_VALUE = "ntn_00000000000Vm0PlaceHolder000000000000000000Aaa";

// ── OpenAPI types ────────────────────────────────────────────────────────

interface OpenApiOperation {
  tags?: string[];
}

type OpenApiPathItem = Record<string, unknown>;

interface OpenApiSpec {
  info?: { version?: string };
  paths?: Record<string, OpenApiPathItem>;
}

// ── Capability mapping ───────────────────────────────────────────────────

const ALL_METHODS = new Set(["get", "head", "post", "put", "patch", "delete"]);
const OPENAPI_PATH_KEYS = new Set([
  "summary",
  "description",
  "servers",
  "parameters",
  "$ref",
  "options",
  "trace",
]);

// Tags to skip (OAuth endpoints are not behind capabilities).
const SKIP_TAGS = new Set(["OAuth"]);

// Explicit overrides where the default tag+method heuristic is wrong.
// These match Notion's documented capability requirements.
const PATH_OVERRIDES: Record<string, Record<string, string>> = {
  // Querying a data source is reading, not inserting
  "/v1/data_sources/{data_source_id}/query": { post: "read_content" },
  // Moving a page is updating, not inserting
  "/v1/pages/{page_id}/move": { post: "update_content" },
  // Appending children to a block is inserting content
  "/v1/blocks/{block_id}/children": { patch: "insert_content" },
};

/**
 * Map (tag, HTTP method, path) → capability name.
 *
 * This matches Notion's documented capability requirements:
 * - Comments: GET → read_comments, POST → insert_comments
 * - Users: all → read_users
 * - Search: POST → read_content (search reads, despite being POST)
 * - Explicit overrides for edge cases (see PATH_OVERRIDES)
 * - Everything else: GET → read_content, POST → insert_content,
 *   PATCH/DELETE → update_content
 */
function getCapability(
  tag: string,
  method: string,
  apiPath: string,
): string | null {
  if (SKIP_TAGS.has(tag)) return null;

  const m = method.toLowerCase();

  // Check explicit overrides first
  const override = PATH_OVERRIDES[apiPath]?.[m];
  if (override) return override;

  if (tag === "Comments") {
    if (m === "get") return "read_comments";
    if (m === "post") return "insert_comments";
  }

  if (tag === "Users") {
    return "read_users";
  }

  if (tag === "Search") {
    return "read_content";
  }

  // Default mapping for content tags (Pages, Databases, Blocks, etc.)
  if (m === "get") return "read_content";
  if (m === "post") return "insert_content";
  if (m === "patch" || m === "delete") return "update_content";

  return null;
}

// ── Capability descriptions ──────────────────────────────────────────────

const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  insert_comments: "Create comments",
  insert_content:
    "Create pages, databases, blocks, data sources, and upload files",
  read_comments: "Read comments",
  read_content: "Read pages, databases, blocks, data sources, and files",
  read_users: "Read user information",
  update_content:
    "Update and delete pages, databases, blocks, and data sources",
};

// ── Grouping ─────────────────────────────────────────────────────────────

interface PermissionGroup {
  name: string;
  description: string;
  rules: string[];
}

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

function sortRules(rules: string[]): string[] {
  return [...rules].sort((a, b) => {
    const [pathA, orderA] = ruleKey(a);
    const [pathB, orderB] = ruleKey(b);
    return pathA < pathB ? -1 : pathA > pathB ? 1 : orderA - orderB;
  });
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
      const tags = operation.tags ?? [];
      if (tags.length === 0) continue;

      const tag = tags[0];
      if (!tag) continue;

      const capability = getCapability(tag, methodLower, apiPath);
      if (!capability) continue;

      // Strip /v1 prefix since the base URL already includes it
      const rulePath = apiPath.startsWith("/v1/") ? apiPath.slice(3) : apiPath;
      const rule = `${methodLower.toUpperCase()} ${rulePath}`;
      let ruleSet = groups.get(capability);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(capability, ruleSet);
      }
      ruleSet.add(rule);
    }
  }

  return [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => {
      const description = CAPABILITY_DESCRIPTIONS[name];
      if (!description) {
        throw new Error(`Unknown capability: ${name}`);
      }
      return {
        name,
        description,
        rules: sortRules([...ruleSet]),
      };
    });
}

// ── TypeScript generation ────────────────────────────────────────────────

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function generateTypeScript(permissions: PermissionGroup[]): string {
  const lines: string[] = [
    "// Auto-generated from Notion's official OpenAPI spec.",
    `// Source: ${OPENAPI_URL}`,
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:notion",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../contracts/firewalls";',
    "",
    "export const notionFirewall: FirewallConfig = {",
    '  name: "notion",',
    '  description: "Notion API",',
    "  placeholders: {",
    `    NOTION_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.notion.com/v1",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.NOTION_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  // Catch-all: allows all endpoints
  lines.push("        {");
  lines.push('          name: "unrestricted",');
  lines.push('          description: "Allow all endpoints",');
  lines.push("          rules: [");
  lines.push('            "ANY /{path*}",');
  lines.push("          ],");
  lines.push("        },");

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

  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  console.error("Downloading Notion OpenAPI spec…");
  const res = await fetch(OPENAPI_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`,
    );
  }
  const spec = (await res.json()) as OpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissions = buildGroups(spec);
  const ts = generateTypeScript(permissions);

  const totalRules = permissions.reduce((sum, p) => sum + p.rules.length, 0);
  console.error(
    `  ${permissions.length} permission groups, ${totalRules} rules`,
  );

  const outPath = path.resolve(
    import.meta.dirname,
    "../../core/src/firewalls/notion.generated.ts",
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, ts);
  console.error(`  Written to ${outPath}`);

  const stat = fs.statSync(outPath);
  if (stat.size === 0) {
    throw new Error("Generated file is empty");
  }
  console.error(`  Validated (${(stat.size / 1024).toFixed(1)} KB)`);
}
