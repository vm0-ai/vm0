import type { ConnectorConfig } from "../connectors";

export const coda = {
  coda: {
    label: "Coda",
    category: "docs-files-knowledge",
    helpText:
      "Connect your Coda account to read and write docs, tables, rows, and pages",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Open Coda and click your avatar (bottom left) then **Account Settings**\n2. Scroll to **API Settings**\n3. Click **Generate API Token**, give it a name, optionally restrict scope\n4. Copy the token and paste it here",
        grant: {
          kind: "manual",
          fields: {
            CODA_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "your-coda-api-token",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CODA_TOKEN: "$secrets.CODA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
