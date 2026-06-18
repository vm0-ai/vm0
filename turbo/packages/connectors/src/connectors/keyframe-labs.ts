import type { ConnectorConfig } from "../connectors";

export const keyframeLabs = {
  "keyframe-labs": {
    label: "Keyframe Labs",
    category: "ai-image-video",
    helpText:
      "Connect your Keyframe Labs account to access realtime AI video persona APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Keyframe Labs account\n2. Follow the [Keyframe Labs API docs](https://docs.keyframelabs.com) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["KEYFRAME_LABS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            KEYFRAME_LABS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-keyframe-labs-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            KEYFRAME_LABS_API_KEY: "$secrets.KEYFRAME_LABS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
