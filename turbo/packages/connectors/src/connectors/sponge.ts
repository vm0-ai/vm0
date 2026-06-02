import type { ConnectorConfig } from "../connectors";

export const sponge = {
  sponge: {
    label: "Sponge",
    category: "sales-crm-business-operations",
    tags: ["wallet", "payments", "agent-economy", "x402", "mpp", "crypto"],
    helpText:
      "Connect Sponge to give agents wallets, cards, bank accounts, and pay x402 / MPP endpoints",
    authMethods: {
      "api-token": {
        label: "Master API Key",
        helpText:
          "1. Sign in to the [Sponge Wallet dashboard](https://wallet.paysponge.com)\n2. Open **Settings → Master API Keys**\n3. Click **Create master key**, name it, and copy the value (prefix `sponge_master_...`)\n\nThe master key is the platform credential. Sponge agent runtime keys are minted on demand through it — store the master key once and never embed it in agent traffic.",
        storage: {
          secrets: ["SPONGE_MASTER_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SPONGE_MASTER_KEY: {
              label: "Master API Key",
              required: true,
              placeholder: "sponge_master_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SPONGE_MASTER_KEY: "$secrets.SPONGE_MASTER_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
