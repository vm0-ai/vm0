import type { ConnectorConfig } from "../connectors";

export const duffel = {
  duffel: {
    label: "Duffel",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Duffel account to search and book flights and stays (hotels) through the Duffel API",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Log in to the [Duffel dashboard](https://app.duffel.com)\n2. Click your organisation name, then **Developers > Access tokens**\n3. Click **New token**, give it a name, leave scope as **Read write**\n4. Click **Create token** and copy the value (format: `duffel_test_...` for test mode, `duffel_live_...` for live mode)",
        grant: {
          kind: "manual",
          fields: {
            DUFFEL_TOKEN: {
              label: "Access Token",
              required: true,
              placeholder: "duffel_test_...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            DUFFEL_TOKEN: "$secrets.DUFFEL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
