import type { ConnectorConfig } from "../connectors";

export const gong = {
  gong: {
    label: "Gong",
    category: "sales-crm-business-operations",
    tags: ["sales", "calls", "transcripts", "revenue-intelligence"],
    helpText:
      "Connect your Gong account to access calls, transcripts, users, and revenue intelligence data",
    authMethods: {
      "api-token": {
        label: "Access Key",
        helpText:
          "1. In Gong, go to **Company Settings → Ecosystem → API** (requires the Technical Administrator permission profile)\n2. Click **Create** to generate an Access Key and Access Key Secret\n3. Copy both values — the secret is shown only once\n4. Copy the **API Base URL** shown on the same screen (e.g. `api.gong.io`, or your region-specific host)",
        storage: {
          secrets: ["GONG_ACCESS_KEY", "GONG_ACCESS_KEY_SECRET"],
          variables: ["GONG_API_BASE"],
        },
        grant: {
          kind: "manual",
          fields: {
            GONG_ACCESS_KEY: {
              label: "Access Key",
              required: true,
            },
            GONG_ACCESS_KEY_SECRET: {
              label: "Access Key Secret",
              required: true,
            },
            GONG_API_BASE: {
              label: "API Base URL",
              required: true,
              storage: "variable",
              placeholder: "api.gong.io",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            GONG_ACCESS_KEY: "$secrets.GONG_ACCESS_KEY",
            GONG_ACCESS_KEY_SECRET: "$secrets.GONG_ACCESS_KEY_SECRET",
            GONG_API_BASE: "$vars.GONG_API_BASE",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
