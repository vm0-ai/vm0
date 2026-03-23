/**
 * Generate GitHub firewall config from GitHub's official permissions data.
 *
 * Data source: server-to-server-permissions.json from github/docs
 * (https://github.com/github/docs/tree/main/src/github-apps/data)
 *
 * This JSON is the same data that powers the GitHub docs page:
 * https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
 *
 * It provides a definitive (verb, requestPath) → permission mapping with
 * access level (read/write) for every REST API endpoint. No heuristics
 * or manual mapping needed — the classification is entirely data-driven.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PERMS_URL =
  "https://raw.githubusercontent.com/github/docs/main/src/github-apps/data/fpt-2026-03-10/server-to-server-permissions.json";

// ── Placeholder token generation ─────────────────────────────────────────
//
// GitHub tokens use CRC32 checksums for offline format validation.
// Structure: prefix (4 chars) + entropy (30 chars) + checksum (6 chars)
// Reference: https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62Encode(num: number, pad = 6): string {
  if (num === 0) return "0".repeat(pad);
  const digits: string[] = [];
  let n = num;
  while (n > 0) {
    digits.push(BASE62[n % 62]!);
    n = Math.floor(n / 62);
  }
  return digits.reverse().join("").padStart(pad, "0");
}

function crc32(data: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeGitHubPlaceholder(
  prefix = "gho_",
  entropy = "Vm0PlaceHolder0000000000000000",
): string {
  return `${prefix}${entropy}${base62Encode(crc32(entropy))}`;
}

// ── Path conversion ──────────────────────────────────────────────────────

// Parameters that may contain slashes → greedy suffix.
const CATCH_ALL: [string, string][] = [
  ["/contents/{path}", "/contents/{path*}"],
  ["/git/ref/{ref}", "/git/ref/{ref+}"],
  ["/git/refs/{ref}", "/git/refs/{ref+}"],
  ["/git/matching-refs/{ref}", "/git/matching-refs/{ref+}"],
  ["/compare/{basehead}", "/compare/{basehead+}"],
];

function convertPath(p: string): string {
  for (const [old, replacement] of CATCH_ALL) {
    if (p.endsWith(old)) {
      return p.slice(0, -old.length) + replacement;
    }
  }
  return p;
}

// ── Types for permissions JSON ───────────────────────────────────────────

interface PermEndpoint {
  verb: string;
  requestPath: string;
  access: string;
}

interface PermEntry {
  title?: string;
  displayTitle?: string;
  permissions: PermEndpoint[];
}

type PermsData = Record<string, PermEntry>;

// ── Grouping ─────────────────────────────────────────────────────────────

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

interface PermissionGroup {
  name: string;
  description: string;
  rules: string[];
}

function buildGroups(permsData: PermsData): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  const descriptions = new Map<string, string>();

  for (const [permKey, entry] of Object.entries(permsData)) {
    const title = entry.title ?? entry.displayTitle ?? "";
    for (const ep of entry.permissions) {
      if (!ep.verb || !ep.requestPath || !ep.access) {
        throw new Error(
          `Endpoint missing verb/requestPath/access in permission "${permKey}": ${JSON.stringify(ep)}`,
        );
      }
      const groupName = `${permKey}:${ep.access}`;
      let ruleSet = groups.get(groupName);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(groupName, ruleSet);
      }
      const fwPath = convertPath(ep.requestPath);
      ruleSet.add(`${ep.verb.toUpperCase()} ${fwPath}`);
      if (!descriptions.has(groupName)) {
        descriptions.set(groupName, title);
      }
    }
  }

  return [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .map(([name, ruleSet]) => ({
      name,
      description: descriptions.get(name) ?? "",
      rules: sortRules([...ruleSet]),
    }));
}

// ── TypeScript generation ────────────────────────────────────────────────

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function generateTypeScript(permissions: PermissionGroup[]): string {
  const placeholder = makeGitHubPlaceholder();

  const lines: string[] = [
    "// Auto-generated from GitHub's official permissions data.",
    "// Source: github/docs/src/github-apps/data/fpt-2026-03-10/server-to-server-permissions.json",
    `// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:github`,
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../contracts/firewalls";',
    "",
    "export const githubFirewall: FirewallConfig = {",
    '  name: "github",',
    '  description: "GitHub API",',
    "  placeholders: {",
    `    GITHUB_TOKEN: "${placeholder}",`,
    `    GH_TOKEN: "${placeholder}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.github.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  // Catch-all: allows all endpoints (for users who only need token injection)
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

  // uploads.github.com — release asset upload endpoint.
  lines.push("    {");
  lines.push('      base: "https://uploads.github.com",');
  lines.push("      auth: {");
  lines.push("        headers: {");
  lines.push('          Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",');
  lines.push("        },");
  lines.push("      },");
  lines.push("      permissions: [");
  lines.push("        {");
  lines.push('          name: "unrestricted",');
  lines.push('          description: "Allow all endpoints",');
  lines.push("          rules: [");
  lines.push('            "ANY /{path*}",');
  lines.push("          ],");
  lines.push("        },");
  lines.push("        {");
  lines.push('          name: "contents:write",');
  lines.push('          description: "Upload release assets",');
  lines.push("          rules: [");
  lines.push(
    '            "POST /repos/{owner}/{repo}/releases/{release_id}/assets",',
  );
  lines.push("          ],");
  lines.push("        },");
  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  console.error("Downloading GitHub permissions data…");
  const res = await fetch(PERMS_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch permissions data: ${res.status} ${res.statusText}`,
    );
  }
  const permsData = (await res.json()) as PermsData;
  console.error(`  ${Object.keys(permsData).length} permissions`);

  const permissions = buildGroups(permsData);
  const ts = generateTypeScript(permissions);

  const totalRules = permissions.reduce((sum, p) => sum + p.rules.length, 0);
  console.error(
    `  ${permissions.length} permission groups, ${totalRules} rules`,
  );

  const outPath = path.resolve(
    import.meta.dirname,
    "../../core/src/firewalls/github.generated.ts",
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, ts);
  console.error(`  Written to ${outPath}`);

  // Validate the generated config matches the schema
  validateGeneratedConfig(outPath);
}

function validateGeneratedConfig(outPath: string): void {
  // We can't dynamically import the generated TS at this point,
  // but type-checking via tsc will catch schema mismatches.
  // Just verify the file was written and is non-empty.
  const stat = fs.statSync(outPath);
  if (stat.size === 0) {
    throw new Error("Generated file is empty");
  }
  console.error(`  Validated (${(stat.size / 1024).toFixed(1)} KB)`);
}
