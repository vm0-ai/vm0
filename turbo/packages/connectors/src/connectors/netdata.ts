import type { ConnectorConfig } from "../connectors";

export const netdata = {
  netdata: {
    label: "Netdata",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Netdata Cloud account to query spaces, nodes, metric contexts, and observability data",
    tags: ["observability", "metrics", "monitoring", "alerts"],
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Netdata Cloud](https://app.netdata.cloud)\n2. Click your profile picture in the bottom-left corner\n3. Select **User Settings**\n4. Navigate to **API Tokens**\n5. Create a token with the scopes required for your use case and copy it",
        storage: {
          secrets: ["NETDATA_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            NETDATA_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "eyJhbGciOi...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            NETDATA_TOKEN: "$secrets.NETDATA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
