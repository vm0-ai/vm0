const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export async function fetchTelegramFile(url: string): Promise<Response> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download Telegram file: ${response.status} ${response.statusText}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const size = Number(contentLength);
    if (Number.isSafeInteger(size) && size > MAX_FILE_SIZE_BYTES) {
      throw new Error("File exceeds maximum size limit");
    }
  }

  return response;
}
