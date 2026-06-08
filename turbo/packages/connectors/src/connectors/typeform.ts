import type { ConnectorConfig } from "../connectors";

export const typeform = {
  typeform: {
    label: "Typeform",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Typeform account to create forms, fetch responses, and manage webhooks",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [Typeform](https://admin.typeform.com)\n2. Open the account menu (top-right) and pick **Personal tokens**\n3. Click **Generate a new token**, name it, and choose the scopes you need (e.g. `forms:read`, `responses:read`, `webhooks:write`)\n4. Copy the token (format: `tfp_...`)",
        storage: {
          secrets: ["TYPEFORM_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            TYPEFORM_TOKEN: {
              label: "Personal Access Token",
              required: true,
              placeholder: "tfp_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TYPEFORM_TOKEN: "$secrets.TYPEFORM_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
