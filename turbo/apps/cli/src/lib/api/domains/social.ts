import {
  socialContract,
  socialKitErrorSchema,
  publicSocialErrorCode,
  publicSocialErrorMessage,
  type SocialKitDownloadRequest,
  type SocialKitDownloadResponse,
  type SocialKitRequest,
  type SocialKitResponse,
} from "@okouai/api-contracts/contracts/social";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

const SOCIALKIT_API_TIMEOUT_MS = 280_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicSocialDownloadResponse(
  response: SocialKitDownloadResponse,
): SocialKitDownloadResponse {
  if (!response.error) {
    return response;
  }
  return {
    ...response,
    error: {
      ...response.error,
      code: publicSocialErrorCode(response.error.code),
      message: publicSocialErrorMessage(response.error.message),
    },
  };
}

function handlePublicSocialError(
  result: { readonly status: number; readonly body: unknown },
  defaultMessage: string,
): never {
  const parsed = socialKitErrorSchema.safeParse(result.body);
  const rawError = isRecord(result.body) ? result.body.error : undefined;
  const rawErrorRecord = isRecord(rawError) ? rawError : undefined;
  const code = parsed.success
    ? parsed.data.error.code
    : typeof rawErrorRecord?.code === "string"
      ? rawErrorRecord.code
      : "UNKNOWN";
  const message = parsed.success
    ? parsed.data.error.message
    : typeof rawErrorRecord?.message === "string"
      ? rawErrorRecord.message
      : defaultMessage;
  const reason = parsed.success ? parsed.data.error.reason : undefined;
  handleError(
    {
      status: result.status,
      body: {
        error: {
          ...(reason ? { reason } : {}),
          code: publicSocialErrorCode(code),
          message: publicSocialErrorMessage(message),
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
    return publicSocialDownloadResponse(result.body);
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
    return publicSocialDownloadResponse(result.body);
  }
  handlePublicSocialError(result, "Okou Social download status failed");
}
