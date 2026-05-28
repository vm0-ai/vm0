import type { ConnectorConfig } from "../connectors";

export const x = {
  x: {
    label: "X",
    category: "marketing-content-growth",
    helpText:
      "Connect your X (Twitter) account to read tweets, timelines, and search",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with X to grant read access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://api.x.com/2/oauth2/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "X_OAUTH_CLIENT_ID",
            clientSecretEnv: "X_OAUTH_CLIENT_SECRET",
          },
          scopes: [
            "tweet.read", // All the Tweets you can view, including Tweets from protected accounts.
            "tweet.write", // Tweet and Retweet for you.
            "tweet.moderate.write", // Hide and unhide replies to your Tweets.
            "users.email", // Email from an authenticated user.
            "users.read", // Any account you can view, including protected accounts.
            "follows.read", // People who follow you and people who you follow.
            "follows.write", // Follow and unfollow people for you.
            "offline.access", // Stay connected to your account until you revoke access.
            "space.read", // All the Spaces you can view.
            "mute.read", // Accounts you've muted.
            "mute.write", // Mute and unmute accounts for you.
            "like.read", // Tweets you've liked and likes you can view.
            "like.write", // Like and un-like Tweets for you.
            "list.read", // Lists, list members, and list followers of lists you've created or are a member of, including private lists.
            "list.write", // Create and manage Lists for you.
            "block.read", // Accounts you've blocked.
            "block.write", // Block and unblock accounts for you.
            "bookmark.read", // Get Bookmarked Tweets from an authenticated user.
            "bookmark.write", // Bookmark and remove Bookmarks from Tweets.
            "dm.read", // All the Direct Messages you can view, including Direct Messages from protected accounts.
            "dm.write", // Send and manage Direct Messages for you.
            "media.write", // Upload media.
          ],
        },
        access: {
          kind: "refresh-token",
          accessToken: "X_ACCESS_TOKEN",
          refreshToken: "X_REFRESH_TOKEN",
          envBindings: {
            X_TOKEN: "$secrets.X_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
