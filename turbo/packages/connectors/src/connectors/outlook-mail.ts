import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const outlookMail = {
  "outlook-mail": {
    label: "Outlook Mail",
    category: "communication-collaboration",
    environmentMapping: {
      OUTLOOK_MAIL_TOKEN: "$secrets.OUTLOOK_MAIL_ACCESS_TOKEN",
    },
    helpText: "Connect your Microsoft Outlook account to send and read emails",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.OutlookMailConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Microsoft to grant Outlook Mail access.",
        secrets: {
          OUTLOOK_MAIL_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          OUTLOOK_MAIL_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      },
      scopes: ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
