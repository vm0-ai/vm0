import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const ramp = {
  ramp: {
    label: "Ramp",
    category: "sales-crm-business-operations",
    tags: ["expenses", "cards", "receipts", "limits", "accounting"],
    helpText:
      "Connect a Ramp developer app to access cards, receipts, transactions, reimbursements, users, and spending limits",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.RampConnector,
        label: "Client Credentials",
        helpText:
          "1. Open the Ramp Developer Console\n2. Create an app with the Client Credentials grant enabled\n3. Copy the client ID and client secret",
        storage: {
          version: 1,
          secrets: ["RAMP_CLIENT_SECRET", "RAMP_ACCESS_TOKEN"],
          variables: ["RAMP_CLIENT_ID", "RAMP_SCOPE"],
        },
        grant: {
          kind: "manual",
          fields: {
            RAMP_CLIENT_ID: {
              label: "Client ID",
              publicId: "clientId",
              required: true,
              storage: "variable",
            },
            RAMP_CLIENT_SECRET: {
              label: "Client Secret",
              publicId: "clientSecret",
              required: true,
            },
            RAMP_SCOPE: {
              label: "OAuth Scopes",
              publicId: "scope",
              required: true,
              storage: "variable",
              placeholder: "transactions:read users:read",
            },
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            clientId: "$vars.RAMP_CLIENT_ID",
            clientSecret: "$secrets.RAMP_CLIENT_SECRET",
            scope: "$vars.RAMP_SCOPE",
          },
          outputs: { accessToken: "$secrets.RAMP_ACCESS_TOKEN" },
          refreshableSecrets: ["RAMP_ACCESS_TOKEN"],
          envBindings: { RAMP_TOKEN: "$secrets.RAMP_ACCESS_TOKEN" },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
