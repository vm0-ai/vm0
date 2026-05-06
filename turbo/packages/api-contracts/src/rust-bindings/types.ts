import type { z } from "zod";
import {
  artifactEntrySchema,
  storageEntrySchema,
  storageManifestSchema,
} from "../contracts/runners";
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
}

export const rustTypeBindings = [
  {
    schema: artifactEntrySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "ArtifactEntry",
    direction: "response",
  },
  {
    schema: storageEntrySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageEntry",
    direction: "response",
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
  },
  {
    schema: webhookStoragesPrepareContract.prepare.body,
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      storageType: "String",
    },
  },
  {
    schema: webhookStoragesPrepareContract.prepare.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Response",
    direction: "response",
  },
  {
    schema: webhookStoragesCommitContract.commit.body,
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      storageType: "String",
    },
  },
  {
    schema: webhookStoragesCommitContract.commit.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Response",
    direction: "response",
  },
] as const satisfies readonly RustTypeBinding[];
