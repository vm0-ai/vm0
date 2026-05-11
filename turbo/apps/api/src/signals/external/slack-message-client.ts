import { WebClient, type Block, type KnownBlock } from "@slack/web-api";

import { safeAsync } from "../utils";

type OpenDmResult =
  | { readonly kind: "ok"; readonly channelId: string }
  | { readonly kind: "slack_error"; readonly error: string };

type PostMessageResult =
  | {
      readonly kind: "ok";
      readonly ts: string | undefined;
      readonly channel: string | undefined;
    }
  | { readonly kind: "slack_error"; readonly error: string };

export function createSlackClient(token: string): WebClient {
  return new WebClient(token);
}

function isSlackPlatformError(
  err: unknown,
): err is Error & { data: { error: string } } {
  if (!(err instanceof Error) || !("data" in err)) {
    return false;
  }
  const { data } = err as { data: unknown };
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  );
}

export async function openDMChannel(
  client: WebClient,
  userId: string,
): Promise<OpenDmResult> {
  const result = await safeAsync(() => {
    return client.conversations.open({ users: userId });
  });
  if ("error" in result) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  if (!result.ok.channel?.id) {
    return { kind: "slack_error", error: "missing_channel_id" };
  }
  return { kind: "ok", channelId: result.ok.channel.id };
}

export async function postMessage(
  client: WebClient,
  channel: string,
  text: string,
  options?: {
    readonly threadTs?: string;
    readonly blocks?: (Block | KnownBlock)[];
  },
): Promise<PostMessageResult> {
  const result = await safeAsync(() => {
    return client.chat.postMessage({
      channel,
      text,
      thread_ts: options?.threadTs,
      blocks: options?.blocks,
    });
  });
  if ("error" in result) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  return { kind: "ok", ts: result.ok.ts, channel: result.ok.channel };
}

type GetUploadUrlResult =
  | {
      readonly kind: "ok";
      readonly uploadUrl: string;
      readonly fileId: string;
    }
  | { readonly kind: "slack_error"; readonly error: string };

export async function getUploadUrlExternal(
  client: WebClient,
  args: { readonly filename: string; readonly length: number },
): Promise<GetUploadUrlResult> {
  const result = await safeAsync(() => {
    return client.files.getUploadURLExternal({
      filename: args.filename,
      length: args.length,
    });
  });
  if ("error" in result) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  if (!result.ok.ok || !result.ok.upload_url || !result.ok.file_id) {
    return { kind: "slack_error", error: result.ok.error ?? "unknown error" };
  }
  return {
    kind: "ok",
    uploadUrl: result.ok.upload_url,
    fileId: result.ok.file_id,
  };
}

type CompleteUploadResult =
  | { readonly kind: "ok" }
  | { readonly kind: "slack_error"; readonly error: string };

export async function completeUploadExternal(
  client: WebClient,
  args: {
    readonly fileId: string;
    readonly channel: string;
    readonly threadTs?: string;
    readonly title?: string;
    readonly initialComment?: string;
  },
): Promise<CompleteUploadResult> {
  const result = await safeAsync(() => {
    return client.files.completeUploadExternal({
      files: [{ id: args.fileId, title: args.title }],
      channel_id: args.channel,
      thread_ts: args.threadTs,
      initial_comment: args.initialComment,
    });
  });
  if ("error" in result) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  return { kind: "ok" };
}

export interface SlackFileInfo {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly filetype?: string;
  readonly size?: number;
  readonly permalink?: string;
}

type GetFileInfoResult =
  | { readonly kind: "ok"; readonly file: SlackFileInfo | undefined }
  | { readonly kind: "slack_error"; readonly error: string };

export async function getFileInfo(
  client: WebClient,
  fileId: string,
): Promise<GetFileInfoResult> {
  const result = await safeAsync(() => {
    return client.files.info({ file: fileId });
  });
  if ("error" in result) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  const file = result.ok.file as SlackFileInfo | undefined;
  return { kind: "ok", file };
}
