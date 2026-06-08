import type { ConnectorConfig } from "../connectors";

export const snowflake = {
  snowflake: {
    label: "Snowflake",
    category: "data-automation-infrastructure",
    tags: ["data-warehouse", "warehouse", "sql", "analytics", "database"],
    helpText:
      "Connect your Snowflake account to run SQL statements and call Snowflake REST APIs for databases, schemas, tables, warehouses, and account metadata",
    authMethods: {
      "api-token": {
        label: "Programmatic Access Token",
        helpText:
          "1. In Snowflake, generate a programmatic access token for the user or service user that should own the connection\n2. Copy the generated token secret when Snowflake displays it\n3. Enter your Snowflake account identifier, for example `myorganization-myaccount` from `https://myorganization-myaccount.snowflakecomputing.com`",
        storage: {
          secrets: ["SNOWFLAKE_PAT"],
          variables: ["SNOWFLAKE_ACCOUNT"],
        },
        grant: {
          kind: "manual",
          fields: {
            SNOWFLAKE_PAT: {
              label: "Programmatic Access Token",
              required: true,
              placeholder: "your-snowflake-pat",
            },
            SNOWFLAKE_ACCOUNT: {
              label: "Account Identifier",
              required: true,
              placeholder: "myorganization-myaccount",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SNOWFLAKE_PAT: "$secrets.SNOWFLAKE_PAT",
            SNOWFLAKE_ACCOUNT: "$vars.SNOWFLAKE_ACCOUNT",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
