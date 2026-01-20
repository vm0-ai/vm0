import {
  storagesPrepareContract,
  storagesCommitContract,
  storagesDownloadContract,
  storagesListContract,
} from "@vm0/core";
import {
  getClientConfig,
  createClient,
  handleError,
} from "../core/client-factory";

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
  const client = createClient(storagesPrepareContract, config);

  const result = await client.prepare({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to prepare storage");
}

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
  const client = createClient(storagesCommitContract, config);

  const result = await client.commit({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to commit storage");
}

export async function getStorageDownload(query: {
  name: string;
  type: "volume" | "artifact";
  version?: string;
}): Promise<
  | {
      url: string;
      versionId: string;
      fileCount: number;
      size: number;
    }
  | {
      empty: true;
      versionId: string;
      fileCount: 0;
      size: 0;
    }
> {
  const config = await getClientConfig();
  const client = createClient(storagesDownloadContract, config);

  const result = await client.download({
    query: {
      name: query.name,
      type: query.type,
      version: query.version,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Storage "${query.name}" not found`);
}

export async function listStorages(query: {
  type: "volume" | "artifact";
}): Promise<
  Array<{
    name: string;
    size: number;
    fileCount: number;
    updatedAt: string;
  }>
> {
  const config = await getClientConfig();
  const client = createClient(storagesListContract, config);

  const result = await client.list({ query });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to list ${query.type}s`);
}
