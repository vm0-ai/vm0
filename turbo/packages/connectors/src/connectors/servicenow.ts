import type { ConnectorConfig } from "../connectors";

export const servicenow = {
  servicenow: {
    label: "ServiceNow",
    category: "engineering-team-execution",
    tags: ["itsm", "incident", "change-request", "cmdb", "now-platform"],
    helpText:
      "Connect your ServiceNow instance to query and update incidents, change requests, the CMDB, and any other table via the Table API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In ServiceNow, create (or pick) a dedicated service user with the roles the integration needs — `itil` for incident/change, `cmdb_read` for CMDB, etc.\n2. Set a password on that user under **User Administration → Users**\n3. Enter the username, password, and your ServiceNow instance subdomain — the prefix of `https://<subdomain>.service-now.com`",
        storage: {
          secrets: ["SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"],
          variables: ["SERVICENOW_INSTANCE"],
        },
        grant: {
          kind: "manual",
          fields: {
            SERVICENOW_USERNAME: {
              label: "Username",
              required: true,
              placeholder: "service-account-user",
            },
            SERVICENOW_PASSWORD: {
              label: "Password",
              required: true,
              placeholder: "service-account-password",
            },
            SERVICENOW_INSTANCE: {
              label: "Instance",
              required: true,
              storage: "variable",
              placeholder: "your-subdomain",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SERVICENOW_USERNAME: "$secrets.SERVICENOW_USERNAME",
            SERVICENOW_PASSWORD: "$secrets.SERVICENOW_PASSWORD",
            SERVICENOW_INSTANCE: "$vars.SERVICENOW_INSTANCE",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
