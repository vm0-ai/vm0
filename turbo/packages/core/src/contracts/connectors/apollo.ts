import type { ConnectorConfig } from "../connectors";

export const apollo = {
  apollo: {
    label: "Apollo",
    environmentMapping: {
      APOLLO_TOKEN: "$secrets.APOLLO_TOKEN",
    },
    helpText:
      "Connect your Apollo account to search prospects, enrich contacts, manage accounts, deals, sequences, and more",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Apollo](https://app.apollo.io)\n2. Go to **Settings > Integrations**\n3. Click **Connect** beside Apollo API\n4. Select **API Keys > Create new key**\n5. Enter a name, select endpoint access (or toggle **Set as master key**)\n6. Copy the API key",
        secrets: {
          APOLLO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-apollo-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
