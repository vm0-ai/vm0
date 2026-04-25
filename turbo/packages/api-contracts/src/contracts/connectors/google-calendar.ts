import type { ConnectorConfig } from "../connectors";

export const googleCalendar = {
  "google-calendar": {
    label: "Google Calendar",
    category: "meetings-scheduling",
    tags: ["calendar", "scheduling", "gcal"],
    environmentMapping: {
      GOOGLE_CALENDAR_TOKEN: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Google account to access and manage calendar events",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Calendar access.",
        secrets: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_CALENDAR_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
