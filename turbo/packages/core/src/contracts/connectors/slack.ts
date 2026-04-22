import type { ConnectorConfig } from "../connectors";

export const slack = {
  slack: {
    label: "Slack",
    tags: ["chat", "messaging", "im"],
    environmentMapping: {
      SLACK_TOKEN: "$secrets.SLACK_ACCESS_TOKEN",
    },
    helpText: "Connect your Slack account to send messages and read channels",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Slack to grant access.",
        secrets: {
          SLACK_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      // Note: Slack does not approve `search:read` or user `*:history`
      // scopes outside of RTS / MCP applications. The personal connector
      // intentionally omits them. Bot-side history access is provided
      // separately by the org install flow's SLACK_BOT_SCOPES.
      scopes: [
        // Channels
        "channels:read",
        // Messaging
        "chat:write",
        // Users
        "users:read",
        "users:read.email",
        // Files
        "files:read",
        "files:write",
        // Direct messages (high priority)
        "im:write",
        // Reactions (high priority)
        "reactions:read",
        "reactions:write",
        // Private channels (high priority)
        "groups:read",
        // Reminders (medium priority)
        "reminders:read",
        "reminders:write",
        // Pins (medium priority)
        "pins:read",
        "pins:write",
        // User groups (medium priority)
        "usergroups:read",
        // Do Not Disturb (low priority)
        "dnd:read",
        // Bookmarks (low priority)
        "bookmarks:read",
        // Team info (low priority)
        "team:read",
        // Custom emoji (low priority)
        "emoji:read",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
