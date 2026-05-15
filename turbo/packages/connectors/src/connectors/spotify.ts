import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const spotify = {
  spotify: {
    label: "Spotify",
    category: "data-automation-infrastructure",
    environmentMapping: {
      SPOTIFY_TOKEN: "$secrets.SPOTIFY_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Spotify account to manage playlists, control playback, and access music data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.SpotifyConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Spotify to grant access.",
        secrets: {
          SPOTIFY_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          SPOTIFY_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.spotify.com/authorize",
      tokenUrl: "https://accounts.spotify.com/api/token",
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
  },
} as const satisfies Record<string, ConnectorConfig>;
