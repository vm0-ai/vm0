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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: [
            "GOOGLE_CALENDAR_ACCESS_TOKEN",
            "GOOGLE_CALENDAR_REFRESH_TOKEN",
          ],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_CALENDAR_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_CALENDAR_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_CALENDAR_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_CALENDAR_ACCESS_TOKEN"],
          envBindings: {
            GOOGLE_CALENDAR_TOKEN: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
