import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import {
  socialContract,
  type SocialKitDownloadRequest,
  type SocialKitDownloadResponse,
  type SocialKitRequest,
  type SocialKitResponse,
} from "@okouai/api-contracts/contracts/social";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

const SOCIALKIT_API_TIMEOUT_MS = 280_000;

function handlePublicSocialError(
  result: { readonly status: number; readonly body: unknown },
  defaultMessage: string,
): never {
  const parsed = apiErrorSchema.safeParse(result.body);
  if (!parsed.success) {
    handleError(result, defaultMessage);
  }
  handleError(
    {
      status: result.status,
      body: {
        error: {
          ...parsed.data.error,
          message: parsed.data.error.message.replace(
            /socialkit/giu,
            "Okou Social",
          ),
        },
      },
    },
    defaultMessage,
  );
}

export async function callSocialKit(
  body: SocialKitRequest,
): Promise<SocialKitResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.request({
    headers: {},
    body,
    fetchOptions: { signal: AbortSignal.timeout(SOCIALKIT_API_TIMEOUT_MS) },
  });
  if (result.status === 200) {
    return result.body;
  }
  handlePublicSocialError(result, "Okou Social request failed");
}

export async function createSocialKitDownload(
  body: SocialKitDownloadRequest,
): Promise<SocialKitDownloadResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.createDownload({
    headers: {},
    body,
    fetchOptions: { signal: AbortSignal.timeout(SOCIALKIT_API_TIMEOUT_MS) },
  });
  if (result.status === 202) {
    return result.body;
  }
  handlePublicSocialError(result, "Okou Social download failed to start");
}

export async function getSocialKitDownload(
  downloadId: string,
  signal: AbortSignal,
): Promise<SocialKitDownloadResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.getDownload({
    headers: {},
    params: { downloadId },
    fetchOptions: {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(SOCIALKIT_API_TIMEOUT_MS),
      ]),
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handlePublicSocialError(result, "Okou Social download status failed");
}
