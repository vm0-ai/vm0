// Auto-generated — do not edit.
// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:test-oauth

import type { FirewallConfig } from "../contracts/firewalls";

export const testOauthFirewall = {
  name: "test-oauth",
  description: "Test OAuth connector (internal synthetic provider)",
  placeholders: {
    TEST_OAUTH_TOKEN: "testoauth_placeholder_token",
  },
  apis: [
    {
      base: "https://{pr}.vm6.ai/api/test/oauth-provider",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.TEST_OAUTH_TOKEN }}",
        },
      },
      permissions: [
        {
          name: "echo",
          description: "Test echo endpoint used to verify token injection",
          rules: ["GET /echo"],
        },
      ],
    },
  ],
} as const satisfies FirewallConfig;
