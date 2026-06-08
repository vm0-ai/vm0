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
        storage: {
          secrets: ["DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: ["signature", "extended", "openid"],
          outputs: {
            accessToken: "$secrets.DOCUSIGN_ACCESS_TOKEN",
            refreshToken: "$secrets.DOCUSIGN_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.DOCUSIGN_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.DOCUSIGN_ACCESS_TOKEN",
            refreshToken: "$secrets.DOCUSIGN_REFRESH_TOKEN",
          },
          refreshableSecrets: ["DOCUSIGN_ACCESS_TOKEN"],
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
