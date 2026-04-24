import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const outlookMail = {
  "outlook-mail": {
    label: "Outlook Mail",
    category: "communication-collaboration",
    environmentMapping: {
      OUTLOOK_MAIL_TOKEN: "$secrets.OUTLOOK_MAIL_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.OutlookMailConnector,
    helpText: "Connect your Microsoft Outlook account to send and read emails",
    authMethods: {
      oauth: {
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
      scopes: ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
