import type { ConnectorConfig } from "../connectors";

export const tripo = {
  tripo: {
    label: "Tripo",
    category: "ai-image-video",
    generation: ["image"],
    helpText:
      "Connect your Tripo account to generate 3D models from text or images via the Tripo 3D API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in at [platform.tripo3d.ai](https://platform.tripo3d.ai)\n2. Open **API Keys**\n3. Click **Create API Key**\n4. Copy the key (it begins with `tsk_`). It is shown only once. Paste it here.",
        storage: {
          secrets: ["TRIPO_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            TRIPO_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "tsk_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoc",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TRIPO_API_KEY: "$secrets.TRIPO_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
