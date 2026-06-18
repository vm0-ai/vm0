import type { ConnectorConfig } from "../connectors";

export const testerarmy = {
  testerarmy: {
    label: "TesterArmy",
    category: "engineering-team-execution",
    helpText:
      "Connect your TesterArmy account to access AI web and mobile app testing APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your TesterArmy account\n2. Follow the [TesterArmy API docs](https://docs.tester.army/api-reference/) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["TESTERARMY_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            TESTERARMY_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-testerarmy-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TESTERARMY_API_KEY: "$secrets.TESTERARMY_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
