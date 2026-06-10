import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const cloudflare = {
  cloudflare: {
    label: "Cloudflare",
    category: "engineering-team-execution",
    helpText:
      "Connect your Cloudflare account to manage DNS, zones, workers, and other Cloudflare services",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.CloudflareConnector,
        label: "OAuth",
        helpText: "Sign in with Cloudflare to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "CLOUDFLARE_OAUTH_CLIENT_ID",
          clientSecretEnv: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["CLOUDFLARE_ACCESS_TOKEN", "CLOUDFLARE_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [],
          callbackOrigin: "api",
          outputs: {
            accessToken: "$secrets.CLOUDFLARE_ACCESS_TOKEN",
            refreshToken: "$secrets.CLOUDFLARE_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.CLOUDFLARE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.CLOUDFLARE_ACCESS_TOKEN",
            refreshToken: "$secrets.CLOUDFLARE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["CLOUDFLARE_ACCESS_TOKEN"],
          envBindings: {
            CLOUDFLARE_TOKEN: "$secrets.CLOUDFLARE_ACCESS_TOKEN",
          },
        },
        revoke: {
          kind: "token-revoke",
          inputs: {
            refreshToken: "$secrets.CLOUDFLARE_REFRESH_TOKEN",
          },
        },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)\n2. Go to **My Profile** → **API Tokens**\n3. Click **Create Token** and configure the required permissions\n4. Copy the generated token",
        storage: {
          secrets: ["CLOUDFLARE_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            CLOUDFLARE_TOKEN: {
              label: "API Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            CLOUDFLARE_TOKEN: "$secrets.CLOUDFLARE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
