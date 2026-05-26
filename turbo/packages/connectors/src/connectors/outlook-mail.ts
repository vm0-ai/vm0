import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const outlookMail = {
  "outlook-mail": {
    label: "Outlook Mail",
    category: "communication-collaboration",
    helpText: "Connect your Microsoft Outlook account to send and read emails",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.OutlookMailConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Microsoft to grant Outlook Mail access.",
        grant: {
          kind: "auth-code",
          tokenUrl:
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
            clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
          },
          scopes: [
            "Mail.ReadWrite",
            "Mail.Send",
            "User.Read",
            "offline_access",
          ],
        },
        access: {
          kind: "refresh-token",
          accessToken: "OUTLOOK_MAIL_ACCESS_TOKEN",
          refreshToken: "OUTLOOK_MAIL_REFRESH_TOKEN",
          outputs: {
            OUTLOOK_MAIL_TOKEN: "$secrets.OUTLOOK_MAIL_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
