import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const spotify = {
  spotify: {
    label: "Spotify",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Spotify account to manage playlists, control playback, and access music data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.SpotifyConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Spotify to grant access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://accounts.spotify.com/api/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "SPOTIFY_OAUTH_CLIENT_ID",
            clientSecretEnv: "SPOTIFY_OAUTH_CLIENT_SECRET",
          },
          scopes: [
            "ugc-image-upload",
            "user-read-playback-state",
            "user-modify-playback-state",
            "user-read-currently-playing",
            "app-remote-control",
            "streaming",
            "playlist-read-private",
            "playlist-read-collaborative",
            "playlist-modify-private",
            "playlist-modify-public",
            "user-follow-modify",
            "user-follow-read",
            "user-read-playback-position",
            "user-top-read",
            "user-read-recently-played",
            "user-library-modify",
            "user-library-read",
            "user-read-email",
            "user-read-private",
          ],
        },
        access: {
          kind: "refresh-token",
          accessToken: "SPOTIFY_ACCESS_TOKEN",
          refreshToken: "SPOTIFY_REFRESH_TOKEN",
          outputs: {
            SPOTIFY_TOKEN: "$secrets.SPOTIFY_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
