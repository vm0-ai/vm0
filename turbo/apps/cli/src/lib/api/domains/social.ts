import {
  socialContract,
  type SocialKitDownloadRequest,
  type SocialKitDownloadResponse,
  type SocialKitRequest,
  type SocialKitResponse,
} from "@okouai/api-contracts/contracts/social";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callSocialKit(
  body: SocialKitRequest,
): Promise<SocialKitResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.request({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "SocialKit request failed");
}

export async function createSocialKitDownload(
  body: SocialKitDownloadRequest,
): Promise<SocialKitDownloadResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.createDownload({ headers: {}, body });
  if (result.status === 202) {
    return result.body;
  }
  handleError(result, "SocialKit download failed to start");
}

export async function getSocialKitDownload(
  downloadId: string,
): Promise<SocialKitDownloadResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.getDownload({
    headers: {},
    params: { downloadId },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "SocialKit download status failed");
}
