import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const close = {
  close: {
    label: "Close",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Close account to manage leads, contacts, and opportunities",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.CloseConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Close to grant access.",
        grant: {
          kind: "auth-code",
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
        access: {
          kind: "refresh-token",
          accessToken: "CLOSE_ACCESS_TOKEN",
          refreshToken: "CLOSE_REFRESH_TOKEN",
          outputs: {
            CLOSE_TOKEN: "$secrets.CLOSE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
