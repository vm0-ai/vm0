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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "CLOSE_OAUTH_CLIENT_ID",
          clientSecretEnv: "CLOSE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["CLOSE_ACCESS_TOKEN", "CLOSE_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "CLOSE_ACCESS_TOKEN",
            refreshToken: "CLOSE_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          scopes: ["all.full_access", "offline_access"],
        },
        access: {
          kind: "refresh-token",
          envBindings: {
            CLOSE_TOKEN: "$secrets.CLOSE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
