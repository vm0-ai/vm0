import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const googleMeet = {
  "google-meet": {
    label: "Google Meet",
    category: "meetings-scheduling",
    helpText:
      "Connect your Google account to manage Meet spaces, view conference records, participants, recordings, and transcripts",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Meet access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["GOOGLE_MEET_ACCESS_TOKEN", "GOOGLE_MEET_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "GOOGLE_MEET_ACCESS_TOKEN",
            refreshToken: "GOOGLE_MEET_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "https://www.googleapis.com/auth/meetings.space.created",
            // Use meetings.space.readonly (not meetings.conferencerecords.readonly) — confirmed
            // correct per Google Discovery API. meetings.space.readonly grants read access to
            // spaces and conference records; meetings.conferencerecords.readonly is not a valid
            // OAuth scope in the Google Meet REST API v2 discovery document.
            "https://www.googleapis.com/auth/meetings.space.readonly",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            GOOGLE_MEET_TOKEN: "$secrets.GOOGLE_MEET_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
