import type { ConnectorConfig } from "../connectors";

export const modal = {
  modal: {
    label: "Modal",
    category: "data-automation-infrastructure",
    tags: ["sandbox", "sandboxes", "serverless", "gpu", "code-execution"],
    helpText:
      "Connect your Modal workspace to run serverless compute, Modal Sandboxes, functions, and volumes through the Modal SDK and CLI",
    authMethods: {
      "api-token": {
        label: "Service User Token",
        helpText:
          "1. Open [Modal workspace token settings](https://modal.com/settings/tokens)\n2. Click **New Service User** or create a token for automation\n3. Copy the `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` values\n4. Optionally enter a Modal environment name.",
        storage: {
          secrets: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
          variables: ["MODAL_ENVIRONMENT"],
        },
        grant: {
          kind: "manual",
          fields: {
            MODAL_TOKEN_ID: {
              label: "Token ID",
              required: true,
              placeholder: "ak-CoffeeSafeLocalCoffeeSafeLocalCoffee",
            },
            MODAL_TOKEN_SECRET: {
              label: "Token Secret",
              required: true,
              placeholder: "as-CoffeeSafeLocalCoffeeSafeLocalCoffee",
            },
            MODAL_ENVIRONMENT: {
              label: "Environment",
              required: false,
              placeholder: "main",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MODAL_TOKEN_ID: "$secrets.MODAL_TOKEN_ID",
            MODAL_TOKEN_SECRET: "$secrets.MODAL_TOKEN_SECRET",
            MODAL_ENVIRONMENT: {
              valueRef: "$vars.MODAL_ENVIRONMENT",
              optional: true,
            },
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
