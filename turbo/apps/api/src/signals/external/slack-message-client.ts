import {
  WebClient,
  type Block,
  type KnownBlock,
  type View,
} from "@slack/web-api";

import { optionalEnv } from "../../lib/env";
import { settle } from "../utils";

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

type PostEphemeralResult =
  | { readonly kind: "ok"; readonly ts: string | undefined }
  | { readonly kind: "slack_error"; readonly error: string };

function resolveSlackApiUrl(): string | undefined {
  const slackApiUrl = optionalEnv("SLACK_API_URL");
  if (slackApiUrl) {
    return slackApiUrl;
  }

  const flag = optionalEnv("E2E_SLACK_MOCK_ENABLED");
  const mockEnabled = flag === "1" || flag === "true";
  if (!mockEnabled) {
    return undefined;
  }

  const vercelUrl = optionalEnv("VERCEL_URL");
  if (!vercelUrl) {
    throw new Error(
      "E2E_SLACK_MOCK_ENABLED=1 but VERCEL_URL is unset; cannot redirect Slack Web API traffic to the preview mock routes",
    );
  }

  return `https://${vercelUrl}/api/test/slack-mock/`;
}

export function createSlackClient(token: string): WebClient {
  const slackApiUrl = resolveSlackApiUrl();
  if (!slackApiUrl) {
    return new WebClient(token);
  }

  const bypass = optionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET");
  const headers: Record<string, string> = bypass
    ? {
        "x-vercel-protection-bypass": bypass,
        "x-vm0-test-endpoint-bypass": bypass,
      }
    : {};

  return new WebClient(token, {
    slackApiUrl,
    headers,
    retryConfig: { retries: 1 },
    timeout: 5000,
  });
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
  const result = await settle(client.conversations.open({ users: userId }));
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  if (!result.value.channel?.id) {
    return { kind: "slack_error", error: "missing_channel_id" };
  }
  return { kind: "ok", channelId: result.value.channel.id };
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
  const result = await settle(
    client.chat.postMessage({
      channel,
      text,
      thread_ts: options?.threadTs,
      blocks: options?.blocks,
    }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  return { kind: "ok", ts: result.value.ts, channel: result.value.channel };
}

export async function setThreadStatus(
  client: WebClient,
  channel: string,
  threadTs: string,
  status: string,
): Promise<void> {
  await client.assistant.threads.setStatus({
    channel_id: channel,
    thread_ts: threadTs,
    status,
  });
}

export async function publishAppHome(
  client: WebClient,
  userId: string,
  view: View,
): Promise<void> {
  await client.views.publish({ user_id: userId, view });
}

export async function openView(
  client: WebClient,
  triggerId: string,
  view: View,
): Promise<{ readonly viewId: string | undefined }> {
  const result = await client.views.open({ trigger_id: triggerId, view });
  return { viewId: result.view?.id };
}

export async function postEphemeral(
  client: WebClient,
  options: {
    readonly channel: string;
    readonly user: string;
    readonly text: string;
    readonly threadTs?: string;
    readonly blocks?: (Block | KnownBlock)[];
  },
): Promise<PostEphemeralResult> {
  const result = await settle(
    client.chat.postEphemeral({
      channel: options.channel,
      user: options.user,
      text: options.text,
      thread_ts: options.threadTs,
      blocks: options.blocks,
    }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  return { kind: "ok", ts: result.value.message_ts };
}

export interface SlackUserInfo {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
  readonly timezone?: string;
}

export function formatSenderBlock(info: SlackUserInfo): string {
  const parts = [`id: ${info.id}`];
  if (info.name) {
    parts.push(`name: ${info.name}`);
  }
  if (info.email) {
    parts.push(`email: ${info.email}`);
  }
  if (info.timezone) {
    parts.push(`timezone: ${info.timezone}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

async function fetchSlackUserInfo(
  client: WebClient,
  userId: string,
): Promise<SlackUserInfo | undefined> {
  const result = await client.users.info({ user: userId });
  if (!result.ok || !result.user) {
    return undefined;
  }

  const user = result.user;
  const name =
    user.profile?.display_name ||
    user.profile?.real_name ||
    user.real_name ||
    user.name;
  const email = user.profile?.email;
  const timezone = user.tz_label || user.tz;

  return {
    id: userId,
    name: name || undefined,
    email: email || undefined,
    timezone: timezone || undefined,
  };
}

export async function fetchSlackUserInfoMap(
  client: WebClient,
  userIds: readonly string[],
): Promise<Map<string, SlackUserInfo>> {
  const map = new Map<string, SlackUserInfo>();
  const uniqueIds = [...new Set(userIds)];
  const results = await Promise.allSettled(
    uniqueIds.map(async (id) => {
      const info = await fetchSlackUserInfo(client, id);
      if (info) {
        map.set(id, info);
      }
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      continue;
    }
  }

  return map;
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
  const result = await settle(
    client.files.getUploadURLExternal({
      filename: args.filename,
      length: args.length,
    }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  if (!result.value.ok || !result.value.upload_url || !result.value.file_id) {
    return {
      kind: "slack_error",
      error: result.value.error ?? "unknown error",
    };
  }
  return {
    kind: "ok",
    uploadUrl: result.value.upload_url,
    fileId: result.value.file_id,
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
  const result = await settle(
    client.files.completeUploadExternal({
      files: [{ id: args.fileId, title: args.title }],
      channel_id: args.channel,
      thread_ts: args.threadTs,
      initial_comment: args.initialComment,
    }),
  );
  if (!result.ok) {
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
  const result = await settle(client.files.info({ file: fileId }));
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  const file = result.value.file as SlackFileInfo | undefined;
  return { kind: "ok", file };
}
