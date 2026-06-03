import type { ConnectorConfig } from "../connectors";

export const base44 = {
  base44: {
    label: "Base44",
    category: "ai-agent-apps",
    helpText:
      "Connect your Base44 account to let agents access and manage your Base44 apps",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Sign in with Base44 to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "base44_cli",
        },
        storage: {
          secrets: ["BASE44_ACCESS_TOKEN", "BASE44_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "device-auth",
          scopes: ["apps:read", "apps:write", "offline"],
          outputs: {
            accessToken: "$secrets.BASE44_ACCESS_TOKEN",
            refreshToken: "$secrets.BASE44_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.BASE44_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.BASE44_ACCESS_TOKEN",
            refreshToken: "$secrets.BASE44_REFRESH_TOKEN",
          },
          refreshableSecrets: ["BASE44_ACCESS_TOKEN"],
          envBindings: {
            BASE44_TOKEN: "$secrets.BASE44_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
