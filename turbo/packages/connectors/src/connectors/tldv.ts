import type { ConnectorConfig } from "../connectors";

export const tldv = {
  tldv: {
    label: "tl;dv",
    category: "meetings-scheduling",
    helpText:
      "Connect your tl;dv account to access meeting recordings, transcripts, and AI-generated notes",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Ensure you have a **Business Plan** subscription on [tldv](https://tldv.io)\n2. API and webhook access is only available on the Business Plan\n3. Contact support at **support@tldv.io** to request API access and obtain your credentials",
        grant: {
          kind: "manual",
          fields: {
            TLDV_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-tldv-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            TLDV_TOKEN: "$secrets.TLDV_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
