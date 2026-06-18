import type { ConnectorConfig } from "../connectors";

export const stablebrowse = {
  stablebrowse: {
    label: "StableBrowse",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your StableBrowse account to access browser automation APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your StableBrowse account\n2. Follow the [StableBrowse API docs](https://docs.stablebrowse.com/introduction) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["STABLEBROWSE_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            STABLEBROWSE_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-stablebrowse-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            STABLEBROWSE_API_KEY: "$secrets.STABLEBROWSE_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
