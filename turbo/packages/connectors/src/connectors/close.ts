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
        },
        grant: {
          kind: "auth-code",
          scopes: ["all.full_access", "offline_access"],
          outputs: {
            accessToken: "$secrets.CLOSE_ACCESS_TOKEN",
            refreshToken: "$secrets.CLOSE_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.CLOSE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.CLOSE_ACCESS_TOKEN",
            refreshToken: "$secrets.CLOSE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["CLOSE_ACCESS_TOKEN"],
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
