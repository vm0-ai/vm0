interface SlackApiError {
  ok: false;
  error: string;
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
  params?: Record<string, string | number | boolean | undefined>,
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
  });

  if (!response.ok) {
    throw new Error(
      `Slack API error: ${response.status} ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();

  if (isSlackApiError(data)) {
    throw new Error(`Slack API error: ${data.error}`);
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
): Promise<SlackFileInfo> {
  const result = await callSlackApi<FilesInfoResponse>(token, "files.info", {
    file: fileId,
  });
  return result.file;
}
