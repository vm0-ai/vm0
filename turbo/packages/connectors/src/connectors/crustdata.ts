import type { ConnectorConfig } from "../connectors";

export const crustdata = {
  crustdata: {
    label: "Crustdata",
    category: "sales-crm-business-operations",
    helpText:
      "Connect Crustdata to search and enrich company, person, job, web, and social post data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Request or open your Crustdata API key from the [Crustdata dashboard](https://crustdata.com)\n2. Copy your API key\n3. Crustdata authenticates requests with `Authorization: Bearer <key>` and requires the `x-api-version` header",
        grant: {
          kind: "manual",
          fields: {
            CRUSTDATA_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CRUSTDATA_TOKEN: "$secrets.CRUSTDATA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
