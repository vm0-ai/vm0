import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const docusign = {
  docusign: {
    label: "DocuSign",
    environmentMapping: {
      DOCUSIGN_TOKEN: "$secrets.DOCUSIGN_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.DocuSignConnector,
    helpText:
      "Connect your DocuSign account to send and manage electronic signatures",
    authMethods: {
      oauth: {
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
      authorizationUrl: "https://account-d.docusign.com/oauth/auth",
      tokenUrl: "https://account-d.docusign.com/oauth/token",
      scopes: ["signature", "extended", "openid"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
