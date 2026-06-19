import type { ConnectorConfig } from "../connectors";

export const maskdb = {
  maskdb: {
    label: "maskdb",
    category: "data-automation-infrastructure",
    helpText:
      "Connect maskdb to run read-only, structured queries against a masked Postgres database. Sensitive columns are returned masked and can never be used to filter or sort.",
    authMethods: {
      "api-token": {
        label: "Token",
        helpText:
          "1. Open your [maskdb dashboard](https://github.com/e7h4n/maskdb)\n2. Mint a maskdb token with the `db:query` and `db:metadata` scopes (read-only). It starts with `mk_`\n3. Paste the token here",
        storage: {
          secrets: ["MASKDB_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MASKDB_TOKEN: {
              label: "Token",
              required: true,
              placeholder: "mk_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoc",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MASKDB_TOKEN: "$secrets.MASKDB_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
