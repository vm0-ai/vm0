import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { initClient } from "@ts-rest/core";
import {
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
  type GithubUploadCompleteBody,
  type GithubUploadCompleteResponse,
  type GithubUploadInitBody,
  type GithubUploadInitResponse,
} from "@vm0/api-contracts/contracts/integrations";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";

interface DownloadGithubFileResult {
  path: string;
  mimetype: string;
  size: number;
}

export async function initGithubFileUpload(
  body: GithubUploadInitBody,
): Promise<GithubUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsGithubUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize GitHub file upload");
}

export async function completeGithubFileUpload(
  body: GithubUploadCompleteBody,
): Promise<GithubUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsGithubUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete GitHub file upload");
}

export async function downloadGithubFile(
  fileUrl: string,
  outPath: string,
  filename?: string,
): Promise<DownloadGithubFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/zero/integrations/github/download-file", baseUrl);
  url.searchParams.set("url", fileUrl);
  if (filename) {
    url.searchParams.set("filename", filename);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    let message = `Failed to download GitHub file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // keep generic message when the body is not JSON
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "GitHub download response has no body",
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
