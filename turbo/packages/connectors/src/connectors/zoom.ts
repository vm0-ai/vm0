import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const zoom = {
  zoom: {
    label: "Zoom",
    category: "meetings-scheduling",
    helpText:
      "Connect your Zoom account to schedule meetings, manage cloud recordings, and access webinar and participant data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.ZoomConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Zoom to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "ZOOM_OAUTH_CLIENT_ID",
          clientSecretEnv: "ZOOM_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: "https://zoom.us/oauth/token",
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
        access: {
          kind: "refresh-token",
          accessToken: "ZOOM_ACCESS_TOKEN",
          refreshToken: "ZOOM_REFRESH_TOKEN",
          envBindings: {
            ZOOM_TOKEN: "$secrets.ZOOM_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
