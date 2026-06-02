import type { ConnectorConfig } from "../connectors";

export const infisical = {
  infisical: {
    label: "Infisical",
    category: "engineering-team-execution",
    helpText:
      "Connect your Infisical account to fetch secrets from your projects and environments using a Token Auth identity",
    authMethods: {
      "api-token": {
        label: "Token Auth",
        helpText:
          "1. Log in to [Infisical](https://app.infisical.com)\n2. Go to **Access Control > Machine Identities**\n3. Create a new Machine Identity with **Token Auth**\n4. Copy the **Token**\n5. Assign the identity to your project with the desired role",
        storage: {
          secrets: ["INFISICAL_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            INFISICAL_TOKEN: {
              label: "Token",
              required: true,
              placeholder: "your-infisical-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            INFISICAL_TOKEN: "$secrets.INFISICAL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
