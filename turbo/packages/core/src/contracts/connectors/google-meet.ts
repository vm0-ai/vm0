import type { ConnectorConfig } from "../connectors";

export const googleMeet = {
  "google-meet": {
    label: "Google Meet",
    environmentMapping: {
      GOOGLE_MEET_TOKEN: "$secrets.GOOGLE_MEET_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Google account to manage Meet spaces, view conference records, participants, recordings, and transcripts",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Meet access.",
        secrets: {
          GOOGLE_MEET_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_MEET_REFRESH_TOKEN: {
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
        "https://www.googleapis.com/auth/meetings.space.created",
        // Use meetings.space.readonly (not meetings.conferencerecords.readonly) — confirmed
        // correct per Google Discovery API. meetings.space.readonly grants read access to
        // spaces and conference records; meetings.conferencerecords.readonly is not a valid
        // OAuth scope in the Google Meet REST API v2 discovery document.
        "https://www.googleapis.com/auth/meetings.space.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
