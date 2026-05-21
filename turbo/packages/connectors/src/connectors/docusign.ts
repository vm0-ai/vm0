import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const docusign = {
  docusign: {
    label: "DocuSign",
    category: "data-automation-infrastructure",
    environmentMapping: {
      DOCUSIGN_TOKEN: "$secrets.DOCUSIGN_ACCESS_TOKEN",
    },
    helpText:
      "Connect your DocuSign account to send and manage electronic signatures",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.DocuSignConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with DocuSign to grant access.",
        secrets: {
          DOCUSIGN_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          DOCUSIGN_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      flow: "authorization-code",
      tokenUrl: "https://account-d.docusign.com/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_basic",
        clientIdEnv: "DOCUSIGN_OAUTH_CLIENT_ID",
        clientSecretEnv: "DOCUSIGN_OAUTH_CLIENT_SECRET",
      },
      scopes: ["signature", "extended", "openid"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
