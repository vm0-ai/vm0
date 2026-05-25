import type { ConnectorConfig } from "../connectors";

export const strapi = {
  strapi: {
    label: "Strapi",
    category: "docs-files-knowledge",
    helpText:
      "Connect your Strapi CMS to manage content types, entries, and media via Strapi's REST API",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your Strapi admin panel\n2. Go to **Settings → API Tokens**\n3. Click **Create new API Token**\n4. Enter a name, select a token duration, and choose a token type (Full Access or Custom)\n5. Click **Save** and copy the generated token",
        grant: {
          kind: "manual",
          fields: {
            STRAPI_TOKEN: {
              label: "API Token",
              required: true,
            },
            STRAPI_BASE_URL: {
              label: "Base URL",
              required: true,
              placeholder: "https://your-strapi.example.com",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            STRAPI_TOKEN: "$secrets.STRAPI_TOKEN",
            STRAPI_BASE_URL: "$vars.STRAPI_BASE_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
