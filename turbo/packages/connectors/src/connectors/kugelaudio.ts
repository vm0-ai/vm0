import type { ConnectorConfig } from "../connectors";

export const kugelAudio = {
  kugelaudio: {
    label: "KugelAudio",
    category: "ai-voice-audio",
    helpText:
      "Connect your KugelAudio account to access text-to-speech and voice AI APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your KugelAudio account\n2. Follow the [KugelAudio API docs](https://docs.kugelaudio.com/) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["KUGELAUDIO_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            KUGELAUDIO_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-kugelaudio-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            KUGELAUDIO_API_KEY: "$secrets.KUGELAUDIO_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
