import { initClient } from "@ts-rest/core";
import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";

import { getClientConfig, handleError } from "../core/client-factory";

export async function getRegistryResourceDownload(query: {
  id: string;
}): Promise<{
  url: string;
  id: string;
  type: "tar.gz";
  sha256: string;
  expiresInSeconds: number;
  versionId: string;
  fileCount: number;
  size: number;
}> {
  const config = await getClientConfig();
  const client = initClient(registryResourceDownloadContract, config);

  const result = await client.download({ query });
  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Registry resource "${query.id}" not found`);
}
