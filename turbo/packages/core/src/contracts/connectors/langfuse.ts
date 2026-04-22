import type { ConnectorConfig } from "../connectors";

export const langfuse = {
  langfuse: {
    label: "Langfuse",
    tags: ["observability", "tracing", "llm", "analytics"],
    environmentMapping: {
      LANGFUSE_PUBLIC_KEY: "$secrets.LANGFUSE_PUBLIC_KEY",
      LANGFUSE_SECRET_KEY: "$secrets.LANGFUSE_SECRET_KEY",
    },
    helpText:
      "Connect your Langfuse project to ingest LLM traces, attach evaluate scores, and manage prompt templates",
    authMethods: {
      "api-token": {
        label: "API Keys",
        helpText:
          "1. Sign up at [cloud.langfuse.com](https://cloud.langfuse.com)\n2. Create an organization and a project\n3. In project **Settings → API Keys**, click **Create new API keys**\n4. Copy both the **Public Key** (`pk-lf-...`) and the **Secret Key** (`sk-lf-...`) — the secret is shown only once\n5. Paste both values into the fields below",
        secrets: {
          LANGFUSE_PUBLIC_KEY: {
            label: "Public Key",
            required: true,
            placeholder: "pk-lf-...",
          },
          LANGFUSE_SECRET_KEY: {
            label: "Secret Key",
            required: true,
            placeholder: "sk-lf-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
