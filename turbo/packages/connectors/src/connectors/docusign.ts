import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const docusign = {
  docusign: {
    label: "DocuSign",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your DocuSign account to send and manage electronic signatures",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.DocuSignConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with DocuSign to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "DOCUSIGN_OAUTH_CLIENT_ID",
          clientSecretEnv: "DOCUSIGN_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: "https://account-d.docusign.com/oauth/token",
          scopes: ["signature", "extended", "openid"],
        },
        access: {
          kind: "refresh-token",
          accessToken: "DOCUSIGN_ACCESS_TOKEN",
          refreshToken: "DOCUSIGN_REFRESH_TOKEN",
          envBindings: {
            DOCUSIGN_TOKEN: "$secrets.DOCUSIGN_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
