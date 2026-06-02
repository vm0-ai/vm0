import type { ConnectorConfig } from "../connectors";

export const slack = {
  slack: {
    label: "Slack",
    category: "communication-collaboration",
    tags: ["chat", "messaging", "im"],
    helpText: "Connect your Slack account to send messages and read channels",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Slack to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
          clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["SLACK_ACCESS_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "SLACK_ACCESS_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: "https://slack.com/api/oauth.v2.access",
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
        access: {
          kind: "static",
          envBindings: {
            SLACK_TOKEN: "$secrets.SLACK_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "token-revoke" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
