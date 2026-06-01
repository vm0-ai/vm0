import type { ConnectorConfig } from "../connectors";

export const hitem3d = {
  hitem3d: {
    label: "Hitem3D",
    category: "ai-image-video",
    generation: ["image"],
    tags: ["hi3d", "sparc3d", "ultra3d", "image-to-3d", "3d"],
    helpText:
      "Connect your Hitem3D account to generate 3D models from images through the Hitem3D API",
    authMethods: {
      "api-token": {
        label: "API Credentials",
        helpText:
          "1. Sign in to the [Hitem3D Developer Platform](https://platform.hitem3d.ai)\n2. Purchase or enable a resource package\n3. Open the API Key page and create an enabled API key\n4. Copy the client ID and client secret. Paste them here.",
        grant: {
          kind: "manual",
          fields: {
            HITEM3D_CLIENT_ID: {
              label: "Client ID",
              required: true,
              placeholder: "hitem3d_client_id",
            },
            HITEM3D_CLIENT_SECRET: {
              label: "Client Secret",
              required: true,
              placeholder: "hitem3d_client_secret",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            HITEM3D_CLIENT_ID: "$secrets.HITEM3D_CLIENT_ID",
            HITEM3D_CLIENT_SECRET: "$secrets.HITEM3D_CLIENT_SECRET",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
