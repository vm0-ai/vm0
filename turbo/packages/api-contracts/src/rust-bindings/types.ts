import type { z } from "zod";
import {
  artifactEntrySchema,
  storageEntrySchema,
  storageManifestSchema,
} from "../contracts/runners";
import { fileEntryWithHashSchema } from "../contracts/storages";
import {
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "../contracts/webhooks";

export interface RustTypeBinding {
  readonly schema: z.ZodType;
  readonly rustModulePath: readonly string[];
  readonly rustTypeName: string;
  readonly direction: "request" | "response";
  readonly fieldTypeOverrides?: Readonly<Record<string, string>>;
  readonly declarations: readonly RustTypeDeclarationDoc[];
}

export interface RustTypeDeclarationDoc {
  readonly rustTypeName: string;
  readonly rustDoc: readonly string[];
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly variants?: Readonly<Record<string, readonly string[]>>;
}

export interface RustTypeModuleDoc {
  readonly rustModulePath: readonly string[];
  readonly rustDoc: readonly string[];
}

export const rustTypeRootDoc = [
  "Generated Rust DTOs for selected `@vm0/api-contracts` request and response bodies.",
  "Do not edit by hand; regenerate with `cd turbo && pnpm -F @vm0/api-contracts generate:rust`.",
  "These types preserve the TypeScript wire contract for Rust runner and guest-agent code.",
] as const;

export const rustTypeModuleDocs = [
  {
    rustModulePath: ["runners"],
    rustDoc: ["Runner-facing DTOs generated from TypeScript API contracts."],
  },
  {
    rustModulePath: ["runners", "storage"],
    rustDoc: [
      "Storage manifest DTOs used by runners to mount volumes and artifacts.",
    ],
  },
  {
    rustModulePath: ["webhooks"],
    rustDoc: ["Webhook DTOs generated from TypeScript API contracts."],
  },
  {
    rustModulePath: ["webhooks", "agent"],
    rustDoc: ["Agent webhook DTOs exchanged between sandboxes and the API."],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages"],
    rustDoc: [
      "Sandbox storage upload DTOs shared by guest agents and webhook handlers.",
    ],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustDoc: ["DTOs for committing direct sandbox storage uploads."],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustDoc: ["DTOs for preparing direct sandbox storage uploads."],
  },
] satisfies readonly RustTypeModuleDoc[];

export const rustTypeBindings = [
  {
    schema: artifactEntrySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "ArtifactEntry",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ArtifactEntryMissingRootPolicy",
        rustDoc: [
          "Policy used when an artifact mount root is missing from the uploaded manifest.",
        ],
        variants: {
          fail: ["Treat a missing artifact root as an error."],
          preserveParentVersion: [
            "Preserve the parent artifact version when the root path is missing.",
          ],
        },
      },
      {
        rustTypeName: "ArtifactEntry",
        rustDoc: ["Artifact entry in a runner storage manifest."],
        fields: {
          mountPath: ["Guest filesystem path where the artifact is mounted."],
          vasStorageName: [
            "VAS storage name that stores the artifact versions.",
          ],
          vasStorageId: ["VAS storage identifier for the artifact."],
          vasVersionId: ["VAS version identifier for the artifact contents."],
          archiveUrl: ["Presigned URL for downloading the artifact archive."],
          manifestUrl: [
            "Optional presigned URL for downloading the artifact manifest.",
          ],
          missingRootPolicy: [
            "Optional policy for a missing artifact root; absence behaves like `fail`.",
          ],
        },
      },
    ],
  },
  {
    schema: storageEntrySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageEntry",
    direction: "response",
    declarations: [
      {
        rustTypeName: "StorageEntry",
        rustDoc: ["Volume storage entry in a runner storage manifest."],
        fields: {
          name: ["User-facing storage name referenced by the run."],
          mountPath: ["Guest filesystem path where the storage is mounted."],
          vasStorageName: ["VAS storage name that stores the volume versions."],
          vasVersionId: ["VAS version identifier for the volume contents."],
          instructionsTargetFilename: [
            "Optional filename used when storage instructions are written into the mount.",
          ],
          archiveUrl: ["Presigned URL for downloading the storage archive."],
        },
      },
    ],
  },
  {
    schema: storageManifestSchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageManifest",
    direction: "response",
    fieldTypeOverrides: {
      storages: "Vec<StorageEntry>",
      artifacts: "Vec<ArtifactEntry>",
    },
    declarations: [
      {
        rustTypeName: "StorageManifest",
        rustDoc: [
          "Runner storage manifest containing all volume and artifact mounts.",
        ],
        fields: {
          storages: ["Volume storage entries to mount for the run."],
          artifacts: ["Artifact entries to mount for the run."],
        },
      },
    ],
  },
  {
    schema: fileEntryWithHashSchema,
    rustModulePath: ["webhooks", "agent", "storages"],
    rustTypeName: "FileEntryWithHash",
    direction: "request",
    declarations: [
      {
        rustTypeName: "FileEntryWithHash",
        rustDoc: [
          "File metadata entry used to compute and commit content-addressed storage uploads.",
        ],
        fields: {
          path: ["Path of the file inside the uploaded storage archive."],
          hash: ["SHA-256 hash of the file contents encoded as hex."],
          size: ["File size in bytes."],
        },
      },
    ],
  },
  {
    schema: webhookStoragesPrepareContract.prepare.body,
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      storageType: "String",
      files: "Vec<super::FileEntryWithHash>",
    },
    declarations: [
      {
        rustTypeName: "RequestChanges",
        rustDoc: [
          "Incremental file change set sent while preparing a partial storage upload.",
        ],
        fields: {
          added: ["Paths added since the base storage version."],
          modified: ["Paths modified since the base storage version."],
          deleted: ["Paths deleted since the base storage version."],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: [
          "Request body for preparing a direct sandbox storage upload.",
        ],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          storageName: ["Storage name being prepared for upload."],
          storageType: ["Storage kind encoded by the TypeScript contract."],
          files: ["Content-addressed file list included in the upload."],
          parentVersionId: [
            "Optional parent version used when preparing an incremental upload.",
          ],
          force: ["Whether to bypass deduplication checks for this upload."],
          baseVersion: [
            "Optional base version identifier for an incremental upload.",
          ],
          changes: ["Optional incremental file changes from the base version."],
        },
      },
    ],
  },
  {
    schema: webhookStoragesPrepareContract.prepare.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ResponseUploadsArchive",
        rustDoc: ["Presigned upload target for the storage archive object."],
        fields: {
          key: ["Object key for the archive upload."],
          presignedUrl: ["Presigned URL used to upload the archive object."],
        },
      },
      {
        rustTypeName: "ResponseUploadsManifest",
        rustDoc: ["Presigned upload target for the storage manifest object."],
        fields: {
          key: ["Object key for the manifest upload."],
          presignedUrl: ["Presigned URL used to upload the manifest object."],
        },
      },
      {
        rustTypeName: "ResponseUploads",
        rustDoc: [
          "Upload targets returned when the storage version does not already exist.",
        ],
        fields: {
          archive: ["Archive upload target."],
          manifest: ["Manifest upload target."],
        },
      },
      {
        rustTypeName: "Response",
        rustDoc: [
          "Response body for preparing a direct sandbox storage upload.",
        ],
        fields: {
          versionId: ["Storage version identifier prepared for the upload."],
          existing: [
            "Whether the requested storage version already exists and can be reused.",
          ],
          uploads: [
            "Presigned upload targets when archive and manifest uploads are required.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookStoragesCommitContract.commit.body,
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      storageType: "String",
      files: "Vec<super::FileEntryWithHash>",
    },
    declarations: [
      {
        rustTypeName: "Request",
        rustDoc: [
          "Request body for committing a direct sandbox storage upload.",
        ],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          storageName: ["Storage name being committed."],
          storageType: ["Storage kind encoded by the TypeScript contract."],
          versionId: ["Storage version identifier being committed."],
          parentVersionId: [
            "Optional parent version used when committing an incremental upload.",
          ],
          files: [
            "Content-addressed file list included in the committed upload.",
          ],
          message: [
            "Optional commit message associated with the storage version.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookStoragesCommitContract.commit.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: [
          "Response body returned after committing a direct sandbox storage upload.",
        ],
        fields: {
          success: ["Whether the storage commit succeeded."],
          versionId: ["Committed storage version identifier."],
          storageName: ["Storage name that was committed."],
          size: ["Total committed storage size in bytes."],
          fileCount: [
            "Number of files recorded in the committed storage version.",
          ],
          deduplicated: [
            "Whether the committed version reused existing storage content.",
          ],
        },
      },
    ],
  },
] as const satisfies readonly RustTypeBinding[];
