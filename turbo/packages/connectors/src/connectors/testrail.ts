import type { ConnectorConfig } from "../connectors";

export const testrail = {
  testrail: {
    label: "TestRail",
    category: "engineering-team-execution",
    tags: ["qa", "testing", "test-cases", "test-management", "gurock"],
    helpText:
      "Connect your TestRail account to manage test cases, runs, and results across projects",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In TestRail, open **My Settings** (top-right user menu) → **API Keys**\n2. Click **Add Key**, name it (e.g. `vm0`), copy the generated key\n3. Enter the email you log in with, the generated API key, and your TestRail instance subdomain — the prefix of `https://<subdomain>.testrail.io`\n4. If your team self-hosts TestRail Server, set `TESTRAIL_INSTANCE` to the full host (e.g. `tests.example.com`) — the firewall accepts both forms",
        storage: {
          secrets: ["TESTRAIL_EMAIL", "TESTRAIL_TOKEN"],
          variables: ["TESTRAIL_INSTANCE"],
        },
        grant: {
          kind: "manual",
          fields: {
            TESTRAIL_EMAIL: {
              label: "Email",
              required: true,
              placeholder: "you@example.com",
            },
            TESTRAIL_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-testrail-api-key",
            },
            TESTRAIL_INSTANCE: {
              label: "Instance",
              required: true,
              storage: "variable",
              placeholder: "your-subdomain",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TESTRAIL_EMAIL: "$secrets.TESTRAIL_EMAIL",
            TESTRAIL_TOKEN: "$secrets.TESTRAIL_TOKEN",
            TESTRAIL_INSTANCE: "$vars.TESTRAIL_INSTANCE",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
