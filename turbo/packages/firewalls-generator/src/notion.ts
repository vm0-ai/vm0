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

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  fetchSpec,
  logStats,
  renderPermissions,
  sortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiSpec, PermissionGroup } from "./codegen";

const OPENAPI_URL = "https://developers.notion.com/openapi.json";

// Notion integration token placeholder.
// Format: ntn_[0-9]{11}[A-Za-z0-9]{35} (50 chars total)
const PLACEHOLDER_VALUE = "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";

// ── OpenAPI types ────────────────────────────────────────────────────────

interface NotionOperation {
  tags?: string[];
}

// ── Capability mapping ───────────────────────────────────────────────────

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

      const operation: NotionOperation = op;
      const tags = operation.tags ?? [];
      if (tags.length === 0) continue;

      const tag = tags[0];
      if (!tag) continue;

      const capability = getCapability(tag, methodLower, apiPath);
      if (!capability) continue;

      const rulePath = apiPath;
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
    "export const notionFirewall = {",
    '  name: "notion",',
    '  description: "Notion API",',
    "  placeholders: {",
    `    NOTION_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.notion.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.NOTION_TOKEN }}",',
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
  const res = await fetchSpec(OPENAPI_URL, "Notion OpenAPI spec");
  const spec = (await res.json()) as OpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissions = buildGroups(spec);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("notion", ts, import.meta.dirname);
}
