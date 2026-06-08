import type { ConnectorConfig } from "../connectors";

export const prismaPostgres = {
  "prisma-postgres": {
    label: "Prisma Postgres",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Prisma Postgres database to manage schemas, run queries, and access data through Prisma's serverless database platform",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Prisma Console](https://console.prisma.io)\n2. Go to your workspace **Settings** page\n3. Select **Service Tokens**\n4. Click **New Service Token**\n5. Copy and save the generated service token securely",
        storage: {
          secrets: ["PRISMA_POSTGRES_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PRISMA_POSTGRES_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "eyJhbGci...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PRISMA_POSTGRES_TOKEN: "$secrets.PRISMA_POSTGRES_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
