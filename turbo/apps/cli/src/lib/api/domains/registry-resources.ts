import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";

import { getClientConfig, handleError } from "../core/client-factory";

export async function getPresentationTemplateDownload(query: {
  id: string;
}): Promise<{
  url: string;
  id: string;
  type: "tar.gz";
  expiresInSeconds: number;
  versionId: string;
  fileCount: number;
  size: number;
}> {
  const config = await getClientConfig();
  const client = initClient(registryResourceDownloadContract, config);

  const result = await client.downloadPresentationTemplate({ query });
  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Presentation template "${query.id}" not found`);
}

// Keep registry resource downloads in the CLI release lifecycle.
export async function getRegistryResourceDownload(query: {
  id: string;
  expectedSha256: string;
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
