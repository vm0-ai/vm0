import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { initClient } from "@ts-rest/core";
import {
  integrationsSlackMessageContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadCompleteContract,
  type SendSlackMessageBody,
  type SendSlackMessageResponse,
  type SlackUploadInitBody,
  type SlackUploadInitResponse,
  type SlackUploadCompleteBody,
  type SlackUploadCompleteResponse,
} from "@vm0/api-contracts/contracts/integrations";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";

export async function sendSlackMessage(
  body: SendSlackMessageBody,
): Promise<SendSlackMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to send Slack message");
}

export async function initSlackFileUpload(
  body: SlackUploadInitBody,
): Promise<SlackUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize Slack file upload");
}

export async function completeSlackFileUpload(
  body: SlackUploadCompleteBody,
): Promise<SlackUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete Slack file upload");
}

interface DownloadSlackFileResult {
  path: string;
  mimetype: string;
  size: number;
}

/**
 * Download a Slack file to a local path, streaming the response body to disk.
 * Uses the org bot token on the server side; the CLI just authenticates via
 * ZERO_TOKEN and writes the bytes. Response is binary, so this bypasses the
 * ts-rest contract system.
 */
export async function downloadSlackFile(
  fileId: string,
  outPath: string,
): Promise<DownloadSlackFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/zero/integrations/slack/download-file", baseUrl);
  url.searchParams.set("file_id", fileId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    let message = `Failed to download Slack file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // ignore parse errors — keep generic message
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "Slack download response has no body",
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

  const contentLengthHeader = response.headers.get("content-length");
  const size = contentLengthHeader ? Number(contentLengthHeader) : 0;

  return { path: outPath, mimetype, size };
}
