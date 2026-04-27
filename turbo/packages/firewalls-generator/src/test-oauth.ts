/**
 * Generate Test OAuth firewall config.
 *
 * Synthetic OAuth 2.0 connector served by the web app itself (the fake
 * provider routes live at /api/test/oauth-provider/*). The firewall matches
 * an echo endpoint used by integration + E2E tests to verify the proxy's
 * Authorization injection and mid-run token refresh.
 *
 * Base URL uses a `{pr}` host segment wildcard so the rule matches any
 * preview deployment under `*.vm6.ai` (the domain all test environments
 * resolve to). Production `vm0.ai` is intentionally NOT matched — there is
 * no test-oauth upstream to hit in production, and the isTestEndpointAllowed
 * guard on the echo route would 404 regardless.
 */

import { writeOutput } from "./codegen";

const PLACEHOLDER_VALUE = "testoauth_placeholder_token";

function generateTypeScript(): string {
  const lines: string[] = [
    "// Auto-generated — do not edit.",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:test-oauth",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const testOauthFirewall = {",
    '  name: "test-oauth",',
    '  description: "Test OAuth connector (internal synthetic provider)",',
    "  placeholders: {",
    `    TEST_OAUTH_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://{pr}.vm6.ai/api/test/oauth-provider",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.TEST_OAUTH_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
    "        {",
    '          name: "echo",',
    '          description: "Test echo endpoint used to verify token injection",',
    '          rules: ["GET /echo"],',
    "        },",
    "      ],",
    "    },",
    "  ],",
    "} as const satisfies FirewallConfig;",
    "",
  ];

  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error("Generating Test OAuth firewall config...");
  const ts = generateTypeScript();
  writeOutput("test-oauth", ts, import.meta.dirname);
}
