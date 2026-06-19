import type { ConnectorConfig } from "../connectors";

export const maskdb = {
  maskdb: {
    label: "maskdb",
    category: "data-automation-infrastructure",
    helpText:
      "Connect maskdb to run read-only, structured queries against a masked Postgres database. Sensitive columns are returned masked and can never be used to filter or sort.",
    authMethods: {
      "api-token": {
        label: "Agent Token",
        helpText:
          "1. Open your [maskdb dashboard](https://github.com/e7h4n/maskdb)\n2. Create or copy a maskdb **agent token** (read-only data plane). It starts with `mk_agent_`\n3. Paste the agent token here",
        storage: {
          secrets: ["MASKDB_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MASKDB_TOKEN: {
              label: "Agent Token",
              required: true,
              placeholder:
                "mk_agent_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoc",
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
