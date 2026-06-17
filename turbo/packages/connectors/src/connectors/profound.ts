import type { ConnectorConfig } from "../connectors";

export const profound = {
  profound: {
    label: "Profound",
    category: "marketing-content-growth",
    helpText:
      "Connect your Profound account to access AI search visibility, citations, sentiment, fanout, prompt, agent, and Agent Analytics data",
    tags: [
      "aeo",
      "geo",
      "ai search",
      "answer engine optimization",
      "citations",
      "sentiment",
      "visibility",
    ],
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Profound](https://platform.tryprofound.com)\n2. Open **Settings** from the user menu\n3. Select **API Keys** in the sidebar\n4. Enter a key name and expiration date\n5. Click **Create API Key**\n6. Copy the generated key immediately (it will not be shown again)",
        storage: {
          secrets: ["PROFOUND_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PROFOUND_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-profound-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PROFOUND_API_KEY: "$secrets.PROFOUND_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
