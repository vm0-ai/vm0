import type { ConnectorConfig } from "../connectors";

export const segment = {
  segment: {
    label: "Segment",
    category: "data-automation-infrastructure",
    tags: ["cdp", "analytics", "events", "tracking", "sources", "destinations"],
    helpText:
      "Connect your Segment workspace to manage sources, destinations, tracking plans, and data pipeline configuration through the Public API",
    authMethods: {
      "api-token": {
        label: "Public API Token",
        helpText:
          "1. Log in to [Segment](https://app.segment.com)\n2. Open the workspace you want to manage\n3. Create a Public API token with the permissions required for your workflow\n4. Copy the token",
        storage: {
          secrets: ["SEGMENT_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SEGMENT_TOKEN: {
              label: "Public API Token",
              required: true,
              placeholder: "your-segment-public-api-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SEGMENT_TOKEN: "$secrets.SEGMENT_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
