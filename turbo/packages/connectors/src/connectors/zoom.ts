import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const zoom = {
  zoom: {
    label: "Zoom",
    category: "meetings-scheduling",
    environmentMapping: {
      ZOOM_TOKEN: "$secrets.ZOOM_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Zoom account to schedule meetings, manage cloud recordings, and access webinar and participant data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.ZoomConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Zoom to grant access.",
        secrets: {
          ZOOM_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          ZOOM_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://zoom.us/oauth/authorize",
      tokenUrl: "https://zoom.us/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_basic",
        clientIdEnv: "ZOOM_OAUTH_CLIENT_ID",
        clientSecretEnv: "ZOOM_OAUTH_CLIENT_SECRET",
      },
      // Granular scopes (Zoom's "resource:action:target" format). Covers the
      // core read/write flows documented in the zoom skill: users, meetings,
      // past-meeting data, cloud recordings, and webinars.
      scopes: [
        "user:read:user",
        "meeting:read:list_meetings",
        "meeting:read:meeting",
        "meeting:write:meeting",
        "meeting:update:meeting",
        "meeting:delete:meeting",
        "meeting:update:status",
        "meeting:read:list_past_participants",
        "meeting:read:past_meeting",
        "cloud_recording:read:list_user_recordings",
        "cloud_recording:read:list_recording_files",
        "cloud_recording:read:recording",
        "webinar:read:list_webinars",
        "webinar:read:webinar",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
