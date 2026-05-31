import type { ConnectorConfig } from "../connectors";

const SLOCK_API_BASE_URL = "https://api.slock.ai";
const SLOCK_DEVICE_TOKEN_URL = `${SLOCK_API_BASE_URL}/api/auth/device/token`;
const SLOCK_REFRESH_TOKEN_URL = `${SLOCK_API_BASE_URL}/api/auth/refresh`;

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
        grant: {
          kind: "device-auth",
          deviceAuthUrl: `${SLOCK_API_BASE_URL}/api/auth/device/authorize`,
          tokenUrl: SLOCK_DEVICE_TOKEN_URL,
          scopes: [],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: SLOCK_REFRESH_TOKEN_URL,
          accessToken: "SLOCK_ACCESS_TOKEN",
          refreshToken: "SLOCK_REFRESH_TOKEN",
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
