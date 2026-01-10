/**
 * Unified HTTP request functions for VM0 agent scripts.
 * Uses native fetch with retry logic.
 */
import { execSync } from "child_process";
import {
  API_TOKEN,
  VERCEL_BYPASS,
  HTTP_MAX_TIME,
  HTTP_MAX_TIME_UPLOAD,
  HTTP_MAX_RETRIES,
  HTTP_CONNECT_TIMEOUT,
} from "./common.js";
import { logDebug, logWarn, logError } from "./log.js";

/**
 * HTTP POST with JSON body and retry logic.
 *
 * @param url - Target URL
 * @param data - Object to send as JSON
 * @param maxRetries - Maximum retry attempts
 * @returns Response JSON on success, null on failure
 */
export async function httpPostJson(
  url: string,
  data: Record<string, unknown>,
  maxRetries: number = HTTP_MAX_RETRIES,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_TOKEN}`,
  };

  if (VERCEL_BYPASS) {
    headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
  }

  const body = JSON.stringify(data);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logDebug(`HTTP POST attempt ${attempt}/${maxRetries} to ${url}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        HTTP_MAX_TIME * 1000,
      );

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logWarn(
          `HTTP POST failed (attempt ${attempt}/${maxRetries}): HTTP ${response.status}`,
        );
        if (attempt < maxRetries) {
          await sleep(1000);
          continue;
        }
        return null;
      }

      const responseText = await response.text();
      if (responseText) {
        return JSON.parse(responseText) as Record<string, unknown>;
      }
      return {};
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes("abort")) {
        logWarn(`HTTP POST failed (attempt ${attempt}/${maxRetries}): Timeout`);
      } else {
        logWarn(
          `HTTP POST failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`,
        );
      }
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }

  logError(`HTTP POST failed after ${maxRetries} attempts to ${url}`);
  return null;
}

/**
 * HTTP PUT to a presigned S3 URL with retry logic.
 * Uses curl for reliable large file uploads.
 *
 * @param presignedUrl - S3 presigned PUT URL
 * @param filePath - Path to file to upload
 * @param contentType - Content-Type header value
 * @param maxRetries - Maximum retry attempts
 * @returns true on success, false on failure
 */
export function httpPutPresigned(
  presignedUrl: string,
  filePath: string,
  contentType: string = "application/octet-stream",
  maxRetries: number = HTTP_MAX_RETRIES,
): boolean {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logDebug(`HTTP PUT presigned attempt ${attempt}/${maxRetries}`);

    try {
      // Use curl for reliable large file uploads
      const curlCmd = [
        "curl",
        "-f",
        "-X",
        "PUT",
        "-H",
        `Content-Type: ${contentType}`,
        "--data-binary",
        `@${filePath}`,
        "--connect-timeout",
        String(HTTP_CONNECT_TIMEOUT),
        "--max-time",
        String(HTTP_MAX_TIME_UPLOAD),
        "--silent",
        presignedUrl,
      ];

      execSync(curlCmd.join(" "), {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: HTTP_MAX_TIME_UPLOAD * 1000,
      });

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logWarn(
        `HTTP PUT presigned failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`,
      );
      if (attempt < maxRetries) {
        sleepSync(1000);
      }
    }
  }

  logError(`HTTP PUT presigned failed after ${maxRetries} attempts`);
  return false;
}

/**
 * Download a file from URL with retry logic.
 * Uses curl for reliable downloads.
 *
 * @param url - Source URL
 * @param destPath - Destination file path
 * @param maxRetries - Maximum retry attempts
 * @returns true on success, false on failure
 */
export function httpDownload(
  url: string,
  destPath: string,
  maxRetries: number = HTTP_MAX_RETRIES,
): boolean {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logDebug(`HTTP download attempt ${attempt}/${maxRetries} from ${url}`);

    try {
      const curlCmd = ["curl", "-fsSL", "-o", destPath, `"${url}"`];

      execSync(curlCmd.join(" "), {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: HTTP_MAX_TIME_UPLOAD * 1000,
        shell: "/bin/bash",
      });

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logWarn(
        `HTTP download failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`,
      );
      if (attempt < maxRetries) {
        sleepSync(1000);
      }
    }
  }

  logError(`HTTP download failed after ${maxRetries} attempts from ${url}`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait - only use for short delays in sync functions
  }
}
