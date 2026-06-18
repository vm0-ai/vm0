import type { ConnectorConfig } from "../connectors";

export const smolMachines = {
  "smol-machines": {
    label: "smol machines",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your smol machines account to access microVM and sandbox infrastructure APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your smol machines account\n2. Follow the [smol machines API docs](https://smolmachines.com/docs/cloud-api) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["SMOL_MACHINES_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SMOL_MACHINES_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-smol-machines-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SMOL_MACHINES_API_KEY: "$secrets.SMOL_MACHINES_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
