import type { ConnectorConfig } from "../connectors";

export const slock = {
  slock: {
    label: "Slock",
    category: "ai-agent-apps",
    helpText:
      "Connect your Slock account to let agents access Slock agents, machines, channels, and messages.",
    authMethods: {
      oauth: {
        label: "OAuth Device Authorization",
        helpText: "Sign in with Slock using a device code.",
        client: {
          clientRegistration: "dynamic",
          clientType: "public",
        },
        storage: {
          secrets: [
            "SLOCK_ACCESS_TOKEN",
            "SLOCK_SERVER_ID",
            "SLOCK_REFRESH_TOKEN",
          ],
          variables: [],
          secretRoles: {
            accessToken: "SLOCK_ACCESS_TOKEN",
            refreshToken: "SLOCK_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "device-auth",
          scopes: [],
        },
        access: {
          kind: "refresh-token",
          envBindings: {
            SLOCK_TOKEN: "$secrets.SLOCK_ACCESS_TOKEN",
            SLOCK_SERVER_ID: "$secrets.SLOCK_SERVER_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
