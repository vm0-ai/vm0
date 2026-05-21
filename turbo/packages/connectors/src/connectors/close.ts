import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const close = {
  close: {
    label: "Close",
    category: "sales-crm-business-operations",
    environmentMapping: {
      CLOSE_TOKEN: "$secrets.CLOSE_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Close account to manage leads, contacts, and opportunities",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.CloseConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Close to grant access.",
        secrets: {
          CLOSE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          CLOSE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      flow: "authorization-code",
      tokenUrl: "https://api.close.com/oauth2/token/",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "CLOSE_OAUTH_CLIENT_ID",
        clientSecretEnv: "CLOSE_OAUTH_CLIENT_SECRET",
      },
      scopes: ["all.full_access", "offline_access"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
