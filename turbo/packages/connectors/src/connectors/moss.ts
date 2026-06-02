import type { ConnectorConfig } from "../connectors";

export const moss = {
  moss: {
    label: "Moss",
    category: "ai-memory-tracing-eval",
    tags: ["semantic-search", "voice", "rag", "retrieval", "vector"],
    helpText:
      "Connect Moss for real-time semantic search inside voice and conversational agents",
    authMethods: {
      "api-token": {
        label: "Project Credentials",
        helpText:
          "1. Sign in to [Moss](https://www.moss.dev) and open the project portal\n2. Open **Project Settings → API Keys**\n3. Copy the **Project ID** and **Project Key** for your project (both are required and paired)",
        storage: {
          secrets: ["MOSS_PROJECT_ID", "MOSS_PROJECT_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MOSS_PROJECT_ID: {
              label: "Project ID",
              required: true,
              placeholder: "prj_...",
            },
            MOSS_PROJECT_KEY: {
              label: "Project Key",
              required: true,
              placeholder: "msk_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MOSS_PROJECT_ID: "$secrets.MOSS_PROJECT_ID",
            MOSS_PROJECT_KEY: "$secrets.MOSS_PROJECT_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
