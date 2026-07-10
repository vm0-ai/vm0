import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../firewall-rule-matcher";
import { firewallConfigSchema, type FirewallConfig } from "../firewall-types";

type FirewallAuthConfig = FirewallConfig["apis"][number]["auth"];

const AWS_SIGV4 = {
  accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
  secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
} as const;

function configWithAuth(auth: FirewallAuthConfig): FirewallConfig {
  return {
    name: "auth-strategy",
    apis: [
      {
        base: "https://api.example.com",
        auth,
        permissions: [{ name: "use", rules: ["GET /"] }],
      },
    ],
  };
}

const VALID_AUTH_CASES: ReadonlyArray<{
  readonly name: string;
  readonly auth: FirewallAuthConfig;
}> = [
  { name: "direct headers", auth: { headers: { Authorization: "token" } } },
  { name: "direct query", auth: { query: { api_key: "token" } } },
  {
    name: "direct headers and query",
    auth: { headers: { Authorization: "token" }, query: { api_key: "token" } },
  },
  { name: "base only", auth: { base: "https://hooks.example.com/secret" } },
  {
    name: "base and headers",
    auth: {
      base: "https://hooks.example.com/secret",
      headers: { Authorization: "token" },
    },
  },
  {
    name: "base and query",
    auth: {
      base: "https://hooks.example.com/secret",
      query: { api_key: "token" },
    },
  },
  {
    name: "base, headers, and query",
    auth: {
      base: "https://hooks.example.com/secret",
      headers: { Authorization: "token" },
      query: { api_key: "token" },
    },
  },
  {
    name: "base with empty maps",
    auth: { base: "https://hooks.example.com/secret", headers: {}, query: {} },
  },
  { name: "SigV4", auth: { awsSigv4: AWS_SIGV4 } },
  {
    name: "SigV4 with empty maps",
    auth: { headers: {}, query: {}, awsSigv4: AWS_SIGV4 },
  },
];

const INVALID_AUTH_CASES: ReadonlyArray<{
  readonly name: string;
  readonly auth: FirewallAuthConfig;
}> = [
  { name: "empty base", auth: { base: "" } },
  {
    name: "SigV4 and headers",
    auth: { headers: { Authorization: "token" }, awsSigv4: AWS_SIGV4 },
  },
  {
    name: "SigV4 and query",
    auth: { query: { api_key: "token" }, awsSigv4: AWS_SIGV4 },
  },
  {
    name: "SigV4 and base",
    auth: { base: "https://hooks.example.com/secret", awsSigv4: AWS_SIGV4 },
  },
];

describe("firewall auth strategy validation", () => {
  for (const { name, auth } of VALID_AUTH_CASES) {
    it(`accepts ${name} at schema and executable matcher boundaries`, () => {
      const config = configWithAuth(auth);

      expect(firewallConfigSchema.safeParse(config).success).toBe(true);
      expect(findMatchingPermissions("GET", "/", config)).toEqual(["use"]);
    });
  }

  for (const { name, auth } of INVALID_AUTH_CASES) {
    it(`rejects ${name} at schema and executable matcher boundaries`, () => {
      const config = configWithAuth(auth);

      expect(firewallConfigSchema.safeParse(config).success).toBe(false);
      expect(findMatchingPermissions("GET", "/", config)).toEqual([]);
    });
  }
});
