import type { ConnectorConfig } from "../connectors";

export const similarweb = {
  similarweb: {
    label: "SimilarWeb",
    category: "marketing-content-growth",
    helpText:
      "Connect your SimilarWeb account to access website traffic analytics, competitive intelligence, and market insights",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Similarweb platform](https://pro.similarweb.com/) (admin access required)\n2. From the main menu on the left, select **Settings & Help**, then select **Account**\n3. Under **Data Tools**, select either **REST API** or **Batch API**\n4. Click **Generate a New API Key** on the right\n5. Type the name of the API key, then select whether this is for yourself or another user\n6. Click **Create** — your key will be displayed in the Generated Keys table\n7. In the Generated Keys table, ensure the **Activation** toggle is on for the relevant API key",
        grant: {
          kind: "manual",
          fields: {
            SIMILARWEB_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-similarweb-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            SIMILARWEB_TOKEN: "$secrets.SIMILARWEB_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
