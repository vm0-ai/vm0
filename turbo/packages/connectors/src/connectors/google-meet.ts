import type { ConnectorConfig } from "../connectors";

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
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/meetings.space.created",
            // Use meetings.space.readonly (not meetings.conferencerecords.readonly) — confirmed
            // correct per Google Discovery API. meetings.space.readonly grants read access to
            // spaces and conference records; meetings.conferencerecords.readonly is not a valid
            // OAuth scope in the Google Meet REST API v2 discovery document.
            "https://www.googleapis.com/auth/meetings.space.readonly",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_MEET_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_MEET_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_MEET_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_MEET_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_MEET_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_MEET_ACCESS_TOKEN"],
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
