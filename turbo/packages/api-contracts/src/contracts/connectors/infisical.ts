import type { ConnectorConfig } from "../connectors";

export const infisical = {
  infisical: {
    label: "Infisical",
    category: "engineering-team-execution",
    environmentMapping: {
      INFISICAL_CLIENT_ID: "$secrets.INFISICAL_CLIENT_ID",
      INFISICAL_CLIENT_SECRET: "$secrets.INFISICAL_CLIENT_SECRET",
    },
    helpText:
      "Connect your Infisical account to fetch secrets from your projects and environments using Machine Identity credentials",
    authMethods: {
      "api-token": {
        label: "Machine Identity",
        helpText:
          "1. Log in to [Infisical](https://app.infisical.com)\n2. Go to **Access Control > Machine Identities**\n3. Create a new Machine Identity with **Universal Auth**\n4. Copy the **Client ID** and **Client Secret**\n5. Assign the identity to your project with the desired role",
        secrets: {
          INFISICAL_CLIENT_ID: {
            label: "Client ID",
            required: true,
            placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          },
          INFISICAL_CLIENT_SECRET: {
            label: "Client Secret",
            required: true,
            placeholder: "your-client-secret",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
