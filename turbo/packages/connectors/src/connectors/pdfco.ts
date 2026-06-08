import type { ConnectorConfig } from "../connectors";

export const pdfco = {
  pdfco: {
    label: "PDF.co",
    category: "data-automation-infrastructure",
    generation: ["document"],
    helpText:
      "Connect your PDF.co account to convert, merge, split, and extract data from PDF documents via API",
    authMethods: {
      "api-token": {
        label: "API Key",
        storage: {
          secrets: ["PDFCO_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PDFCO_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-pdfco-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PDFCO_TOKEN: "$secrets.PDFCO_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
