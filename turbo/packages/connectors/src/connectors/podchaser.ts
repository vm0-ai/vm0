import type { ConnectorConfig } from "../connectors";

export const podchaser = {
  podchaser: {
    label: "Podchaser",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Podchaser account to search podcasts, episodes, creators, and access podcast industry data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Podchaser](https://www.podchaser.com)\n2. Go to [Profile > Settings > API](https://www.podchaser.com/profile/settings/api) to retrieve your **API Key** and **API Secret**\n3. Request an access token by sending a POST request to `https://api.podchaser.com/graphql` using the `requestAccessToken` mutation with `grant_type` set to `CLIENT_CREDENTIALS`, your API Key as `client_id`, and your API Secret as `client_secret`\n4. Store the returned access token (it lasts 1 year)",
        grant: {
          kind: "manual",
          fields: {
            PODCHASER_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "your-podchaser-access-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PODCHASER_TOKEN: "$secrets.PODCHASER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
