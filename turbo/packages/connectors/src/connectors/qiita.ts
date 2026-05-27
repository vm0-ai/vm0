import type { ConnectorConfig } from "../connectors";

export const qiita = {
  qiita: {
    label: "Qiita",
    category: "marketing-content-growth",
    helpText:
      "Connect your Qiita account to search, read, and publish technical articles",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Log in to [Qiita](https://qiita.com)\n2. Go to **Settings > Applications**\n3. Create a new access token with the desired scopes (e.g., `read_qiita`, `write_qiita`)\n4. Copy the generated token\n5. Use it in API requests with the header `Authorization: Bearer [your_token]`",
        grant: {
          kind: "manual",
          fields: {
            QIITA_TOKEN: {
              label: "Access Token",
              required: true,
              placeholder: "your-qiita-access-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            QIITA_TOKEN: "$secrets.QIITA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
