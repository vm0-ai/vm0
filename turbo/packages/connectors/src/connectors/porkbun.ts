import type { ConnectorConfig } from "../connectors";

export const porkbun = {
  porkbun: {
    label: "Porkbun",
    category: "engineering-team-execution",
    helpText:
      "Connect your Porkbun account to manage domains, DNS records, SSL bundles, and domain pricing through the Porkbun API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Porkbun](https://porkbun.com)\n2. Open **Account > API Access**\n3. Create an API key and save both the **API Key** and **Secret Key**\n4. Enable API access for each domain you want to manage",
        storage: {
          secrets: ["PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PORKBUN_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "pk1_...",
            },
            PORKBUN_SECRET_API_KEY: {
              label: "Secret Key",
              required: true,
              placeholder: "sk1_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PORKBUN_API_KEY: "$secrets.PORKBUN_API_KEY",
            PORKBUN_SECRET_API_KEY: "$secrets.PORKBUN_SECRET_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
