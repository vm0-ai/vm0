/**
 * Generate Base44 firewall config.
 *
 * Source: https://app.base44.com/.well-known/oauth-authorization-server
 * Runtime endpoint: https://app.base44.com/mcp
 */

import { writeOutput } from "./codegen";

const PLACEHOLDER_VALUE = "base44_placeholder_token";

function generateTypeScript(): string {
  const lines: string[] = [
    "// Auto-generated — do not edit.",
    "// Source: https://app.base44.com/.well-known/oauth-authorization-server",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:base44",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const base44Firewall = {",
    '  name: "base44",',
    '  description: "Base44 MCP",',
    "  placeholders: {",
    `    BASE44_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://app.base44.com/mcp",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.BASE44_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [],",
    "    },",
    "  ],",
    "} as const satisfies FirewallConfig;",
    "",
  ];

  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error("Generating Base44 firewall config...");
  const ts = generateTypeScript();
  writeOutput("base44", ts, import.meta.dirname);
}
