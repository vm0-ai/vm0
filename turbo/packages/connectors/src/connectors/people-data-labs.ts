import type { ConnectorConfig } from "../connectors";

export const peopleDataLabs = {
  "people-data-labs": {
    label: "People Data Labs",
    category: "sales-crm-business-operations",
    environmentMapping: {
      PEOPLE_DATA_LABS_API_KEY: "$secrets.PEOPLE_DATA_LABS_API_KEY",
    },
    helpText:
      "Connect People Data Labs to enrich, search, identify, and clean person and company data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [People Data Labs dashboard](https://dashboard.peopledatalabs.com)\n2. Open your API dashboard\n3. Copy your API key\n4. People Data Labs accepts it in the `X-Api-Key` header",
        secrets: {
          PEOPLE_DATA_LABS_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "your-people-data-labs-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
