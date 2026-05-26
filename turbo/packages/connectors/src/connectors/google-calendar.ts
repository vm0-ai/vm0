import type { ConnectorConfig } from "../connectors";

export const googleCalendar = {
  "google-calendar": {
    label: "Google Calendar",
    category: "meetings-scheduling",
    tags: ["calendar", "scheduling", "gcal"],
    helpText:
      "Connect your Google account to access and manage calendar events",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Calendar access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://oauth2.googleapis.com/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
            clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
          },
          scopes: [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
        },
        access: {
          kind: "refresh-token",
          accessToken: "GOOGLE_CALENDAR_ACCESS_TOKEN",
          refreshToken: "GOOGLE_CALENDAR_REFRESH_TOKEN",
          outputs: {
            GOOGLE_CALENDAR_TOKEN: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
