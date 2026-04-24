import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const outlookCalendar = {
  "outlook-calendar": {
    label: "Outlook Calendar",
    category: "meetings-scheduling",
    environmentMapping: {
      OUTLOOK_CALENDAR_TOKEN: "$secrets.OUTLOOK_CALENDAR_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.OutlookCalendarConnector,
    helpText:
      "Connect your Microsoft account to access and manage Outlook calendar events",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Microsoft to grant Outlook Calendar access.",
        secrets: {
          OUTLOOK_CALENDAR_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          OUTLOOK_CALENDAR_REFRESH_TOKEN: {
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
      scopes: ["Calendars.ReadWrite", "User.Read", "offline_access"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
