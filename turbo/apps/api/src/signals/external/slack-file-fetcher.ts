const ALLOWED_SLACK_DOWNLOAD_HOSTNAMES: ReadonlySet<string> = Object.freeze(
  new Set(["files.slack.com", "files-pri.slack.com", "cdn.slack.com"]),
);

function isValidSlackDownloadUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed) {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    ALLOWED_SLACK_DOWNLOAD_HOSTNAMES.has(parsed.hostname)
  );
}

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export async function fetchSlackFile(
  url: string,
  token: string,
): Promise<Response> {
  if (!isValidSlackDownloadUrl(url)) {
    throw new Error("Invalid Slack download URL");
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download Slack file: ${response.status} ${response.statusText}`,
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
