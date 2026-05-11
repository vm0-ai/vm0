interface SlackApiError {
  ok: false;
  error: string;
}

class SlackApiClientError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly statusCode?: number,
  ) {
    super(
      statusCode
        ? `Slack API error: ${statusCode} ${code}`
        : `Slack API error: ${code}`,
    );
    this.name = "SlackApiClientError";
  }
}

export function isSlackApiClientError(
  error: unknown,
): error is SlackApiClientError {
  return error instanceof SlackApiClientError;
}

function isSlackApiError(value: unknown): value is SlackApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as SlackApiError).ok === false
  );
}

async function callSlackApi<T>(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    signal,
  });

  if (!response.ok) {
    throw new SlackApiClientError(
      method,
      response.statusText || "http_error",
      response.status,
    );
  }

  const data: unknown = await response.json();
  signal?.throwIfAborted();

  if (isSlackApiError(data)) {
    throw new SlackApiClientError(method, data.error);
  }

  return data as T;
}

interface SlackConversation {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_member: boolean;
  is_archived: boolean;
}

interface ConversationsListResponse {
  ok: true;
  channels: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

export async function listConversations(
  token: string,
  options?: {
    types?: string;
    excludeArchived?: boolean;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  const channels: { id: string; name: string }[] = [];
  let cursor: string | undefined;

  do {
    const result = await callSlackApi<ConversationsListResponse>(
      token,
      "conversations.list",
      {
        types: options?.types ?? "public_channel,private_channel",
        exclude_archived: options?.excludeArchived ?? true,
        limit: options?.limit ?? 200,
        cursor,
      },
      signal,
    );

    for (const ch of result.channels ?? []) {
      if (ch.is_member && ch.id && ch.name) {
        channels.push({ id: ch.id, name: ch.name });
      }
    }

    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  channels.sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  return channels;
}

interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

interface FilesInfoResponse {
  ok: true;
  file: SlackFileInfo;
}

export async function getFileInfo(
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<SlackFileInfo> {
  const result = await callSlackApi<FilesInfoResponse>(
    token,
    "files.info",
    {
      file: fileId,
    },
    signal,
  );
  return result.file;
}
