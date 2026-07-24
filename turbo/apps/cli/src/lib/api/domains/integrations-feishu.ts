import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  integrationsFeishuUploadCompleteContract,
  integrationsFeishuUploadInitContract,
  integrationsFeishuMessageContract,
  type FeishuResourceType,
  type FeishuUploadCompleteBody,
  type FeishuUploadCompleteResponse,
  type FeishuUploadInitBody,
  type FeishuUploadInitResponse,
  type SendFeishuMessageBody,
  type SendFeishuMessageResponse,
} from "@vm0/api-contracts/contracts/integrations";

import { headersWithCliClientHeaders } from "../client-headers";
import { getActiveToken } from "../config";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";

interface DownloadFeishuFileResult {
  readonly path: string;
  readonly mimetype: string;
  readonly size: number;
}

export async function sendFeishuMessage(
  body: SendFeishuMessageBody,
): Promise<SendFeishuMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsFeishuMessageContract, config);
  const result = await client.sendMessage({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to send Feishu message");
}

export async function initFeishuFileUpload(
  body: FeishuUploadInitBody,
): Promise<FeishuUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsFeishuUploadInitContract, config);
  const result = await client.init({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to initialize Feishu file upload");
}

export async function completeFeishuFileUpload(
  body: FeishuUploadCompleteBody,
): Promise<FeishuUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsFeishuUploadCompleteContract, config);
  const result = await client.complete({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to complete Feishu file upload");
}

export async function downloadFeishuFile(
  messageId: string,
  fileKey: string,
  resourceType: FeishuResourceType,
  installationId: string | undefined,
  outPath: string,
): Promise<DownloadFeishuFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/zero/integrations/feishu/download-file", baseUrl);
  url.searchParams.set("message_id", messageId);
  url.searchParams.set("file_key", fileKey);
  url.searchParams.set("type", resourceType);
  if (installationId) {
    url.searchParams.set("installation_id", installationId);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  const response = await fetch(url, {
    headers: headersWithCliClientHeaders(headers),
  });
  if (!response.ok) {
    let message = `Failed to download Feishu file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) {
        message = body.error.message;
      }
      if (body.error?.code) {
        code = body.error.code;
      }
    } catch {
      // Keep the generic error when the response body is not JSON.
    }
    throw new ApiRequestError(message, code, response.status);
  }
  if (!response.body) {
    throw new ApiRequestError(
      "Feishu download response has no body",
      "EMPTY_BODY",
      502,
    );
  }

  const mimetype =
    response.headers.get("x-file-mimetype") ??
    response.headers.get("content-type") ??
    "application/octet-stream";
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(outPath),
  );
  const contentLength = response.headers.get("content-length");
  const size = contentLength ? Number(contentLength) : 0;
  return { path: outPath, mimetype, size };
}
