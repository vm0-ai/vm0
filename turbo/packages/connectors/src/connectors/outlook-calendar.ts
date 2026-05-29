import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const outlookCalendar = {
  "outlook-calendar": {
    label: "Outlook Calendar",
    category: "meetings-scheduling",
    helpText:
      "Connect your Microsoft account to access and manage Outlook calendar events",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.OutlookCalendarConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Microsoft to grant Outlook Calendar access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
          clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl:
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          scopes: ["Calendars.ReadWrite", "User.Read", "offline_access"],
        },
        access: {
          kind: "refresh-token",
          accessToken: "OUTLOOK_CALENDAR_ACCESS_TOKEN",
          refreshToken: "OUTLOOK_CALENDAR_REFRESH_TOKEN",
          envBindings: {
            OUTLOOK_CALENDAR_TOKEN: "$secrets.OUTLOOK_CALENDAR_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
