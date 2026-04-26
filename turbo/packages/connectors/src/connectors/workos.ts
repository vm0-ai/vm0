import type { ConnectorConfig } from "../connectors";

export const workos = {
  workos: {
    label: "WorkOS",
    category: "engineering-team-execution",
    helpText:
      "Connect to WorkOS for enterprise SSO, SCIM directory sync, RBAC fine-grained authorization, and audit log management.",
    environmentMapping: { WORKOS_TOKEN: "$secrets.WORKOS_TOKEN" },
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "Go to WorkOS Dashboard → API Keys → copy your secret key (starts with `sk_live_` for production or `sk_test_` for sandbox).",
        secrets: {
          WORKOS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk_live_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
