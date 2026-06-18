import type { ConnectorConfig } from "../connectors";

export const primitive = {
  primitive: {
    label: "primitive",
    category: "communication-collaboration",
    helpText:
      "Connect your primitive account to access email infrastructure APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your primitive account\n2. Follow the [primitive OpenAPI spec](https://www.primitive.dev/openapi.json) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["PRIMITIVE_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PRIMITIVE_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-primitive-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PRIMITIVE_API_KEY: "$secrets.PRIMITIVE_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
