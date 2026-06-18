import type { ConnectorConfig } from "../connectors";

export const trellis = {
  trellis: {
    label: "Trellis",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Trellis account to access short-rental operations APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Trellis account\n2. Follow the [Trellis API docs](https://docs.trellistech.com) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["TRELLIS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            TRELLIS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-trellis-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TRELLIS_API_KEY: "$secrets.TRELLIS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
