/**
 * Shared codegen utilities for firewall config generators.
 *
 * Provides common types, rule sorting, TypeScript rendering helpers,
 * and file I/O used by all individual firewall generators.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

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

// ── Categories ──────────────────────────────────────────────────────────

export interface CategoryConfig {
  /** Permission name → category label (e.g. "Read", "Write", "Admin"). */
  categories: Record<string, string>;
  /** Category display order (first = top of list). */
  displayOrder: string[];
}

/**
 * Render a categories export grouped by category with count comments.
 * Exhaustiveness is enforced at compile time via
 * `Record<PermissionNamesOf<typeof xxxFirewall>, string>`.
 *
 * @param varName - Export variable name (e.g. "slackCategories")
 * @param firewallVar - The firewall config variable for type checking
 * @param config - Category mapping and display order
 */
export function renderCategories(
  varName: string,
  firewallVar: string,
  config: CategoryConfig,
): string[] {
  // Group permissions by category in displayOrder
  const grouped = new Map<string, string[]>();
  for (const cat of config.displayOrder) {
    grouped.set(cat, []);
  }
  for (const [name, category] of Object.entries(config.categories)) {
    const list = grouped.get(category);
    if (!list) {
      throw new Error(
        `renderCategories: category "${category}" (from permission "${name}") is not in displayOrder [${config.displayOrder.join(", ")}]`,
      );
    }
    list.push(name);
  }

  const orderVarName = `${varName.replace(/Categories$/, "")}CategoryOrder`;

  const lines: string[] = [
    "",
    `export const ${varName}: Record<`,
    `  PermissionNamesOf<typeof ${firewallVar}>,`,
    "  string",
    "> = {",
  ];
  for (const [category, perms] of grouped) {
    lines.push(`  // — ${category} (${perms.length}) —`);
    for (const name of perms) {
      lines.push(`  "${escapeString(name)}": "${escapeString(category)}",`);
    }
  }
  lines.push("};");
  lines.push("");
  lines.push(
    `export const ${orderVarName} = [${config.displayOrder.map((c) => `"${escapeString(c)}"`).join(", ")}] as const;`,
  );
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
    `../../connectors/src/firewalls/${serviceName}.generated.ts`,
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
 * Fetch a URL directly from the network. Used by update-specs to populate
 * the local cache. Generators should use fetchSpec() instead.
 */
export async function fetchRemote(
  url: string,
  label: string,
  init?: RequestInit,
): Promise<Response> {
  console.error(`Downloading ${label}…`);
  const res = await fetch(url, init);
  if (!res.ok) {
    // Consume body to release the underlying socket connection
    await res.body?.cancel();
    throw new Error(
      `Failed to fetch ${label}: ${res.status} ${res.statusText}`,
    );
  }
  return res;
}

/**
 * Resolve a URL to its content via the local spec cache.
 *
 * Looks up the URL in specs-map.json → reads the content-addressed file
 * from specs/. Returns a Response-like object with .json() and .text().
 *
 * If the URL is not in the cache, throws with instructions to run update-specs.
 */
export async function fetchSpec(url: string, label: string): Promise<Response> {
  const content = resolveSpecByUrl(url);
  console.error(`Loading ${label} (cached)…`);
  return new Response(content);
}

// ── Local spec cache ────────────────────────────────────────────────────

export const SPECS_DIR = path.resolve(import.meta.dirname, "../specs");
export const MAP_PATH = path.resolve(import.meta.dirname, "../specs-map.json");

export type SpecsMap = Record<string, Record<string, string>>;

// Cached at module load and never invalidated. The generator is a single-shot
// CLI process — the map cannot change during a run. Do not import this module
// in long-running contexts where the cache could become stale.
let cachedMap: SpecsMap | null = null;
let urlIndex: Map<string, { generator: string; hash: string }> | null = null;

function loadSpecsMap(): SpecsMap {
  if (!cachedMap) {
    if (!fs.existsSync(MAP_PATH)) {
      throw new Error(
        `specs-map.json not found.\n` +
          `Run: pnpm -F @vm0/firewalls-generator update-specs`,
      );
    }
    cachedMap = JSON.parse(fs.readFileSync(MAP_PATH, "utf-8")) as SpecsMap;
  }
  return cachedMap;
}

/** Build a flat URL → {generator, hash} index for O(1) lookups. */
function getUrlIndex(): Map<string, { generator: string; hash: string }> {
  if (!urlIndex) {
    const map = loadSpecsMap();
    urlIndex = new Map();
    for (const [generator, section] of Object.entries(map)) {
      for (const [url, hash] of Object.entries(section)) {
        urlIndex.set(url, { generator, hash });
      }
    }
  }
  return urlIndex;
}

/**
 * Look up a URL in specs-map.json and return the file content.
 * Uses a flat index for O(1) lookup. Throws if the URL is not cached.
 */
function resolveSpecByUrl(url: string): string {
  const entry = getUrlIndex().get(url);
  if (!entry) {
    throw new Error(
      `Spec not cached: ${url}\n` +
        `Run: pnpm -F @vm0/firewalls-generator update-specs`,
    );
  }
  const filePath = path.join(SPECS_DIR, entry.generator, entry.hash);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Cached spec file missing: ${filePath}\n` +
        `Run: pnpm -F @vm0/firewalls-generator update-specs ${entry.generator}`,
    );
  }
  return readSpecFile(filePath);
}

/**
 * List all cached specs for a generator. Returns key→content pairs.
 * Used by generators with dynamic discovery (e.g. slack) that need to
 * enumerate all cached entries rather than look up a specific URL.
 */
export function listCachedSpecs(
  generator: string,
): Array<{ key: string; content: string }> {
  const map = loadSpecsMap();
  const section = map[generator];
  if (!section || Object.keys(section).length === 0) {
    throw new Error(
      `No cached specs for: ${generator}\n` +
        `Run: pnpm -F @vm0/firewalls-generator update-specs`,
    );
  }
  return Object.entries(section).map(([key, hash]) => {
    const filePath = path.join(SPECS_DIR, generator, hash);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Cached spec file missing: ${filePath}\n` +
          `Run: pnpm -F @vm0/firewalls-generator update-specs ${generator}`,
      );
    }
    return { key, content: readSpecFile(filePath) };
  });
}

/**
 * Read a cached spec file and decompress (gzip).
 * Spec files are compressed to keep individual files under 1 MB
 * (our pre-commit file size limit).
 */
function readSpecFile(filePath: string): string {
  const compressed = fs.readFileSync(filePath);
  return zlib.gunzipSync(compressed).toString("utf-8");
}

/**
 * Write a spec file, compressing with gzip at max level.
 * The hash (filename) is computed from the original content so
 * content-addressing semantics are preserved.
 */
export function writeSpecFile(filePath: string, content: string): void {
  const compressed = zlib.gzipSync(content, { level: 9 });
  fs.writeFileSync(filePath, compressed);
}

/** Compute SHA-256 hash of content (used by update-specs). */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
