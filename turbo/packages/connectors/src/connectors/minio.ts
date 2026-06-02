import type { ConnectorConfig } from "../connectors";

export const minio = {
  minio: {
    label: "MinIO",
    category: "docs-files-knowledge",
    helpText:
      "Connect your MinIO instance to manage S3-compatible object storage buckets and objects",
    authMethods: {
      "api-token": {
        label: "Access Credentials",
        helpText:
          "1. Log in to the MinIO Console\n2. Navigate to the **Access Keys** section under Security and Access\n3. Click **Create Access Key**\n4. The system automatically generates an access key and secret key\n5. Optionally override the auto-generated values or toggle **Restrict beyond user policy** to limit permissions\n6. Save the secret key in a secure location (you cannot retrieve or reset it after creation)\n7. Click **Create** to finalize",
        storage: {
          secrets: ["MINIO_TOKEN", "MINIO_SECRET_TOKEN"],
          variables: ["MINIO_ENDPOINT"],
        },
        grant: {
          kind: "manual",
          fields: {
            MINIO_TOKEN: {
              label: "Access Key",
              required: true,
              storage: "secret",
            },
            MINIO_SECRET_TOKEN: {
              label: "Secret Key",
              required: true,
              storage: "secret",
            },
            MINIO_ENDPOINT: {
              label: "Endpoint URL",
              required: true,
              placeholder: "https://minio.example.com",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MINIO_TOKEN: "$secrets.MINIO_TOKEN",
            MINIO_SECRET_TOKEN: "$secrets.MINIO_SECRET_TOKEN",
            MINIO_ENDPOINT: "$vars.MINIO_ENDPOINT",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
