import type { ConnectorConfig } from "../connector-config";

export const topvisor = {
  topvisor: {
    label: "Topvisor",
    category: "marketing-content-growth",
    tags: ["seo", "rank tracking", "keyword research", "serp", "site audit"],
    helpText:
      "Connect your Topvisor account to manage SEO projects, keywords, search rankings, SERP data, and site audits",
    authMethods: {
      "api-token": {
        label: "API Credentials",
        helpText:
          "1. Log in to [Topvisor](https://topvisor.com)\n2. Open **Account Settings**\n3. Copy your **User ID**\n4. Create or copy your **API Key** (Topvisor requires a funded account balance to create one)",
        storage: {
          version: 1,
          secrets: ["TOPVISOR_USER_ID", "TOPVISOR_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            TOPVISOR_USER_ID: {
              label: "User ID",
              publicId: "userId",
              required: true,
              placeholder: "123456",
            },
            TOPVISOR_TOKEN: {
              label: "API Key",
              publicId: "apiKey",
              required: true,
              placeholder: "your-topvisor-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TOPVISOR_USER_ID: "$secrets.TOPVISOR_USER_ID",
            TOPVISOR_TOKEN: "$secrets.TOPVISOR_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
