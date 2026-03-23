/**
 * Generate Slack firewall config from Slack API method-to-scope mappings.
 *
 * Data source: slack-ruby/slack-api-ref (community-maintained, auto-synced
 * daily from docs.slack.dev). This is the only available machine-readable
 * source for Slack's method → scope mapping.
 *
 * Repository: https://github.com/slack-ruby/slack-api-ref
 * Path:       docs.slack.dev/methods/*.json
 *
 * Each method JSON file contains:
 *   { "scope": { "bot": ["chat:write"], "user": ["chat:write"] }, ... }
 *
 * We group methods by scope (bot and user union) to generate firewall
 * permission groups. Methods with no scope (like auth.test, oauth.*)
 * are included in a "no_scopes_required" group since they still require
 * a valid token.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const REPO_TARBALL_URL =
  "https://github.com/slack-ruby/slack-api-ref/archive/refs/heads/master.tar.gz";

// ── Data loading ─────────────────────────────────────────────────────────

interface SlackMethodData {
  scope?: {
    bot?: string[];
    user?: string[];
  };
  http_method?: string;
}

async function downloadMethods(): Promise<Map<string, SlackMethodData>> {
  console.error("Downloading slack-api-ref…");

  // Download tarball and extract method JSON files using tar CLI
  const tmpDir = fs.mkdtempSync("/tmp/slack-api-ref-");
  try {
    execSync(
      `curl -sL "${REPO_TARBALL_URL}" | tar xz -C "${tmpDir}" --strip-components=1 --wildcards "*/docs.slack.dev/methods"`,
      { stdio: ["pipe", "pipe", "inherit"] },
    );

    const methodsDir = path.join(tmpDir, "docs.slack.dev", "methods");
    const files = fs
      .readdirSync(methodsDir)
      .filter((f) => f.endsWith(".json") && f !== "methods.json");

    const methods = new Map<string, SlackMethodData>();
    for (const file of files) {
      const methodName = file.replace(/\.json$/, "");
      const content = fs.readFileSync(path.join(methodsDir, file), "utf-8");
      const parsed = JSON.parse(content) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        methods.set(methodName, parsed as SlackMethodData);
      }
    }

    console.error(`  ${methods.size} methods`);
    return methods;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Grouping ─────────────────────────────────────────────────────────────

interface PermissionGroup {
  name: string;
  description?: string;
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

function buildGroups(methods: Map<string, SlackMethodData>): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();

  for (const [methodName, data] of methods) {
    const scope = data.scope;
    if (typeof scope !== "object" || scope === null) continue;

    const botScopes = scope.bot ?? [];
    const userScopes = scope.user ?? [];
    const allScopes = new Set([...botScopes, ...userScopes]);

    const httpMethod = data.http_method;
    if (!httpMethod) {
      throw new Error(`Method "${methodName}" missing http_method`);
    }
    const rule = `${httpMethod.toUpperCase()} /${methodName}`;

    if (allScopes.size === 0) {
      let ruleSet = groups.get("no_scopes_required");
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set("no_scopes_required", ruleSet);
      }
      ruleSet.add(rule);
      continue;
    }

    for (const s of allScopes) {
      let ruleSet = groups.get(s);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(s, ruleSet);
      }
      ruleSet.add(rule);
    }
  }

  // Order: regular scopes sorted, then no_scopes_required at the end
  const ordered: PermissionGroup[] = [];
  const sortedKeys = [...groups.keys()]
    .filter((k) => k !== "no_scopes_required")
    .sort();

  for (const name of sortedKeys) {
    const ruleSet = groups.get(name);
    if (ruleSet && ruleSet.size > 0) {
      ordered.push({ name, rules: sortRules([...ruleSet]) });
    }
  }

  const noScope = groups.get("no_scopes_required");
  if (noScope && noScope.size > 0) {
    ordered.push({
      name: "no_scopes_required",
      description: "Methods that require a valid token but no specific scope",
      rules: sortRules([...noScope]),
    });
  }

  return ordered;
}

// ── TypeScript generation ────────────────────────────────────────────────

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function generateTypeScript(permissions: PermissionGroup[]): string {
  // Slack bot token format: xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*
  const placeholder =
    "xoxb-000000000000-0000000000000-Vm0PlaceHolder0000000000";

  const lines: string[] = [
    "// Auto-generated from Slack API method-to-scope mappings.",
    "// Source: slack-ruby/slack-api-ref (auto-synced daily from docs.slack.dev)",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:slack",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../contracts/firewalls";',
    "",
    "export const slackFirewall: FirewallConfig = {",
    '  name: "slack",',
    '  description: "Slack API",',
    "  placeholders: {",
    `    SLACK_TOKEN: "${placeholder}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://slack.com/api",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.SLACK_TOKEN }}",',
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

  // files.slack.com — file downloads use the same token
  lines.push("    {");
  lines.push('      base: "https://files.slack.com",');
  lines.push("      auth: {");
  lines.push("        headers: {");
  lines.push('          Authorization: "Bearer ${{ secrets.SLACK_TOKEN }}",');
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
  lines.push('          name: "files:read",');
  lines.push('          description: "Download files from Slack",');
  lines.push("          rules: [");
  lines.push('            "GET /{path+}",');
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
  const methods = await downloadMethods();
  const permissions = buildGroups(methods);
  const ts = generateTypeScript(permissions);

  const totalRules = permissions.reduce((sum, p) => sum + p.rules.length, 0);
  console.error(
    `  ${permissions.length} permission groups, ${totalRules} rules`,
  );

  const outPath = path.resolve(
    import.meta.dirname,
    "../../core/src/firewalls/slack.generated.ts",
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
