import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  storagesPrepareContract,
  storagesCommitContract,
} from "@vm0/api-contracts/contracts/storages";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Prepare storage for direct S3 upload
 */
export async function prepareStorage(body: {
  storageName: string;
  storageType: "volume" | "artifact";
  files: Array<{ path: string; hash: string; size: number }>;
  force?: boolean;
}): Promise<{
  versionId: string;
  existing: boolean;
  uploads?: {
    archive: { key: string; presignedUrl: string };
    manifest: { key: string; presignedUrl: string };
  };
}> {
  const config = await getClientConfig();
  const client = initClient(storagesPrepareContract, config);

  const result = await client.prepare({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to prepare storage");
}

/**
 * Commit storage after S3 upload
 */
export async function commitStorage(body: {
  storageName: string;
  storageType: "volume" | "artifact";
  versionId: string;
  files: Array<{ path: string; hash: string; size: number }>;
}): Promise<{
  success: true;
  versionId: string;
  storageName: string;
  size: number;
  fileCount: number;
  deduplicated?: boolean;
}> {
  const config = await getClientConfig();
  const client = initClient(storagesCommitContract, config);

  const result = await client.commit({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to commit storage");
}
