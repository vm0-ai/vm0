/**
 * Unified HTTP request functions for VM0 agent scripts.
 * Uses native fetch() with retry logic.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP POST with JSON body and retry logic.
 *
 * @param url - Target URL
 * @param data - Object to send as JSON
 * @param maxRetries - Maximum retry attempts
 * @returns Response JSON as object on success, null on failure
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
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        if (text) {
          return JSON.parse(text) as Record<string, unknown>;
        }
        return {};
      }

      logWarn(
        `HTTP POST failed (attempt ${attempt}/${maxRetries}): HTTP ${response.status}`,
      );
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
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
 * HTTP POST with multipart form data and retry logic.
 * Uses curl for multipart uploads as it handles large files better.
 *
 * @param url - Target URL
 * @param formFields - Dictionary of form field name -> value
 * @param filePath - Optional path to file to upload
 * @param fileField - Form field name for the file
 * @param maxRetries - Maximum retry attempts
 * @returns Response JSON as object on success, null on failure
 */
export async function httpPostForm(
  url: string,
  formFields: Record<string, string>,
  filePath?: string,
  fileField: string = "file",
  maxRetries: number = HTTP_MAX_RETRIES,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logDebug(`HTTP POST form attempt ${attempt}/${maxRetries} to ${url}`);

    try {
      // Build curl command
      const curlArgs: string[] = [
        "curl",
        "-f",
        "-X",
        "POST",
        url,
        "-H",
        `Authorization: Bearer ${API_TOKEN}`,
        "--connect-timeout",
        String(HTTP_CONNECT_TIMEOUT),
        "--max-time",
        String(HTTP_MAX_TIME_UPLOAD),
        "--silent",
      ];

      if (VERCEL_BYPASS) {
        curlArgs.push("-H", `x-vercel-protection-bypass: ${VERCEL_BYPASS}`);
      }

      // Add form fields
      for (const [key, value] of Object.entries(formFields)) {
        curlArgs.push("-F", `${key}=${value}`);
      }

      // Add file if provided
      if (filePath) {
        curlArgs.push("-F", `${fileField}=@${filePath}`);
      }

      const result = execSync(curlArgs.join(" "), {
        encoding: "utf-8",
        timeout: HTTP_MAX_TIME_UPLOAD * 1000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (result) {
        return JSON.parse(result) as Record<string, unknown>;
      }
      return {};
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("ETIMEDOUT") || errorMsg.includes("timeout")) {
        logWarn(
          `HTTP POST form failed (attempt ${attempt}/${maxRetries}): Timeout`,
        );
      } else {
        logWarn(
          `HTTP POST form failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`,
        );
      }
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }

  logError(`HTTP POST form failed after ${maxRetries} attempts to ${url}`);
  return null;
}

/**
 * HTTP PUT to a presigned S3 URL with retry logic.
 * Used for direct S3 uploads bypassing Vercel's 4.5MB limit.
 *
 * @param presignedUrl - S3 presigned PUT URL
 * @param filePath - Path to file to upload
 * @param contentType - Content-Type header value
 * @param maxRetries - Maximum retry attempts
 * @returns true on success, false on failure
 */
export async function httpPutPresigned(
  presignedUrl: string,
  filePath: string,
  contentType: string = "application/octet-stream",
  maxRetries: number = HTTP_MAX_RETRIES,
): Promise<boolean> {
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
        `"${presignedUrl}"`,
      ].join(" ");

      execSync(curlCmd, {
        timeout: HTTP_MAX_TIME_UPLOAD * 1000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("ETIMEDOUT") || errorMsg.includes("timeout")) {
        logWarn(
          `HTTP PUT presigned failed (attempt ${attempt}/${maxRetries}): Timeout`,
        );
      } else {
        logWarn(
          `HTTP PUT presigned failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`,
        );
      }
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }

  logError(`HTTP PUT presigned failed after ${maxRetries} attempts`);
  return false;
}

/**
 * Download a file from URL with retry logic.
 *
 * @param url - Source URL
 * @param destPath - Destination file path
 * @param maxRetries - Maximum retry attempts
 * @returns true on success, false on failure
 */
export async function httpDownload(
  url: string,
  destPath: string,
  maxRetries: number = HTTP_MAX_RETRIES,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logDebug(`HTTP download attempt ${attempt}/${maxRetries} from ${url}`);

    try {
      const curlCmd = ["curl", "-fsSL", "-o", destPath, `"${url}"`].join(" ");

      execSync(curlCmd, {
        timeout: HTTP_MAX_TIME_UPLOAD * 1000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("ETIMEDOUT") || errorMsg.includes("timeout")) {
        logWarn(
          `HTTP download failed (attempt ${attempt}/${maxRetries}): Timeout`,
        );
      } else {
        logWarn(
          `HTTP download failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`,
        );
      }
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }

  logError(`HTTP download failed after ${maxRetries} attempts from ${url}`);
  return false;
}
