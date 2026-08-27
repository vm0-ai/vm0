import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  type ChatEventSendBody,
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatThreadEvent as ApiChatThreadEvent,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatSearchContract,
  type ChatThreadServiceTier,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
  type ChatSearchResponse,
} from "@okouai/api-contracts/contracts/chat-threads";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
  type ChatEventSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { getClientConfig, handleError } from "../core/client-factory";

export interface ChatThreadSnapshot {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

interface ChatThreadUnread {
  readonly threadId: string;
  readonly unreadAt: string;
}

export type ChatThreadEvent = ApiChatThreadEvent;

type ZeroChatEventSnapshotResult =
  | {
      readonly kind: "snapshot";
      readonly url: string;
      readonly lastEventId: string | null;
      readonly lastSeqId: number;
      readonly projection: ChatEventSnapshotProjection;
      readonly schemaVersion: number;
    }
  | { readonly kind: "missing"; readonly schemaVersion: number };

type ZeroChatEventRowsPage =
  | {
      readonly kind: "rows";
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
      readonly hasMore: boolean;
      readonly schemaVersion: number;
    }
  | { readonly kind: "expired"; readonly schemaVersion: number };

type ChatEventSchemaVersionHeaders = Readonly<{
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]: string;
}>;

function chatEventSchemaVersionHeaders(
  version: number,
): ChatEventSchemaVersionHeaders {
  return Object.freeze({
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]: version.toString(),
  });
}

const CHAT_EVENT_SCHEMA_VERSION_HEADERS = chatEventSchemaVersionHeaders(
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
);

function isChatEventSchemaVersionAhead(response: {
  readonly status: number;
  readonly body: unknown;
}): boolean {
  if (
    response.status !== 409 ||
    typeof response.body !== "object" ||
    response.body === null ||
    !("error" in response.body)
  ) {
    return false;
  }
  const error = response.body.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "CHAT_EVENT_SCHEMA_VERSION_AHEAD"
  );
}

/**
 * V7 pinned CLI -> V6 API rollback bridge. Remove with #29362 after the V6
 * API leaves serving/rollback and V7 CLI contexts have drained.
 */
async function requestWithChatEventSchemaVersionFallback<
  T extends { readonly status: number; readonly body: unknown },
>(
  request: (headers: ChatEventSchemaVersionHeaders) => Promise<T>,
): Promise<{ readonly response: T; readonly requestedVersion: number }> {
  const response = await request(CHAT_EVENT_SCHEMA_VERSION_HEADERS);
  if (!isChatEventSchemaVersionAhead(response)) {
    return {
      response,
      requestedVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    };
  }
  return {
    response: await request(
      chatEventSchemaVersionHeaders(PREVIOUS_CHAT_EVENT_SCHEMA_VERSION),
    ),
    requestedVersion: PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  };
}

function assertChatEventSchemaVersion(
  headers: Headers,
  requestedVersion: number = CURRENT_CHAT_EVENT_SCHEMA_VERSION,
): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  if (version !== requestedVersion.toString()) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}

function requireSupportedModel(model: string) {
  if (!isSupportedRunModel(model)) {
    throw new Error(`Unsupported chat model: ${model}`);
  }
  return model;
}

interface ZeroChatThreadCreateResult {
  readonly threadId: string;
  readonly title: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
}

interface ZeroChatEventSendResult {
  readonly runId: string | null;
  readonly threadId: string;
  readonly status?: string;
  readonly createdAt?: string;
}

type ZeroChatThreadEventsResult =
  | {
      readonly kind: "page";
      readonly events: readonly ChatThreadEvent[];
      readonly hasMore: boolean;
    }
  | { readonly kind: "expired" };

export async function searchChat(options: {
  keyword: string;
  agentId?: string;
  since?: number;
  limit?: number;
  before?: number;
  after?: number;
}): Promise<ChatSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(chatSearchContract, config);
  const result = await client.search({
    query: {
      keyword: options.keyword,
      agentId: options.agentId,
      since: options.since,
      limit: options.limit,
      before: options.before,
      after: options.after,
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to search chat messages");
}

export async function getChatThreadSnapshot(): Promise<ChatThreadSnapshot> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.snapshot();
  if (result.status === 200) {
    return {
      chatThreads: result.body.chatThreads,
      latestEventId: result.body.latestEventId,
      latestSeqId: result.body.latestSeqId,
    };
  }
  handleError(result, "Failed to get chat thread snapshot");
}

export async function listChatThreadEvents(options: {
  sinceSeqId?: number;
}): Promise<ZeroChatThreadEventsResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.events({
    query:
      options.sinceSeqId === undefined
        ? {}
        : { sinceSeqId: options.sinceSeqId },
  });
  if (result.status === 200) {
    return {
      kind: "page",
      events: result.body.events,
      hasMore: result.body.hasMore,
    };
  }
  if (result.status === 410) {
    return { kind: "expired" };
  }
  handleError(result, "Failed to list chat thread events");
}

export async function listChatThreadUnreads(options: {
  agentId: string;
}): Promise<readonly ChatThreadUnread[]> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.unreads({
    query: { agentId: options.agentId },
  });
  if (result.status === 200) {
    return result.body.unreads;
  }
  handleError(result, "Failed to list unread chat threads");
}

export async function createChatThread(options: {
  agentId: string;
  title: string;
  model?: string;
  serviceTier?: ChatThreadServiceTier | null;
}): Promise<ZeroChatThreadCreateResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.create({
    body: {
      agentId: options.agentId,
      title: options.title,
      ...(options.model === undefined
        ? {}
        : { model: requireSupportedModel(options.model) }),
      ...(options.serviceTier === undefined
        ? {}
        : { serviceTier: options.serviceTier }),
    },
  });
  if (result.status === 201) {
    return {
      threadId: result.body.id,
      title: result.body.title,
      selectedModel: result.body.selectedModel,
      serviceTier: result.body.serviceTier,
    };
  }
  handleError(result, "Failed to create chat thread");
}

export async function renameChatThread(options: {
  threadId: string;
  title: string;
}): Promise<{ threadId: string; title: string }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadRenameContract, config);
  const result = await client.rename({
    params: { id: options.threadId },
    body: { title: options.title },
  });
  if (result.status === 204) {
    return { threadId: options.threadId, title: options.title };
  }
  handleError(result, "Failed to rename chat thread");
}

export async function getChatThread(options: {
  threadId: string;
}): Promise<ChatThreadMetadata> {
  const config = await getClientConfig();
  const client = initClient(chatThreadMetadataContract, config);
  const result = await client.get({
    params: { id: options.threadId },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to get chat thread");
}

export async function getChatThreadAgentId(options: {
  threadId: string;
}): Promise<string> {
  const thread = await getChatThread(options);
  return thread.agentId;
}

export async function sendChatEvent(
  body: ChatEventSendBody,
): Promise<ZeroChatEventSendResult> {
  const config = await getClientConfig();
  const client = initClient(chatEventsContract, config);
  const result = await client.send({ body });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to send chat event");
}

export async function getChatEventSnapshot(options: {
  readonly threadId: string;
}): Promise<ZeroChatEventSnapshotResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadEventsContract, config);
  const versioned = await requestWithChatEventSchemaVersionFallback(
    async (headers) => {
      return await client.snapshot({
        headers,
        params: { threadId: options.threadId },
      });
    },
  );
  const result = versioned.response;
  assertChatEventSchemaVersion(result.headers, versioned.requestedVersion);
  if (result.status === 200) {
    // New pinned CLI -> old API fallback. Remove with #29362 after the old API
    // leaves rollback and contexts pinned to this CLI have drained.
    return {
      kind: "snapshot",
      url: result.body.url,
      lastEventId: result.body.lastEventId,
      lastSeqId: result.body.lastSeqId,
      projection: result.body.projection ?? "full",
      schemaVersion: versioned.requestedVersion,
    };
  }
  if (result.status === 404) {
    return {
      kind: "missing",
      schemaVersion: versioned.requestedVersion,
    };
  }
  handleError(result, "Failed to get chat event snapshot");
}

export async function listChatEventRows(
  options: {
    readonly threadId: string;
    readonly limit: number;
  } & (
    | { readonly sinceEventId: null; readonly sinceSeqId: 0 }
    | {
        readonly sinceEventId: string;
        readonly sinceSeqId: number;
        readonly sinceProjection?: ChatEventSnapshotProjection;
      }
  ),
): Promise<ZeroChatEventRowsPage> {
  const config = await getClientConfig();
  const client = initClient(chatThreadEventsContract, config);
  const versioned = await requestWithChatEventSchemaVersionFallback(
    async (headers) => {
      return await client.rows({
        headers,
        params: { threadId: options.threadId },
        query:
          options.sinceEventId === null
            ? { sinceSeqId: 0, limit: options.limit }
            : {
                sinceSeqId: options.sinceSeqId,
                sinceEventId: options.sinceEventId,
                ...(options.sinceProjection === undefined
                  ? {}
                  : { sinceProjection: options.sinceProjection }),
                limit: options.limit,
              },
      });
    },
  );
  const result = versioned.response;
  assertChatEventSchemaVersion(result.headers, versioned.requestedVersion);
  if (result.status === 200) {
    // New pinned CLI -> old API fallback. Remove with #29362 after the old API
    // leaves rollback and contexts pinned to this CLI have drained.
    const projection =
      result.body.projection ??
      (options.sinceEventId === null ? undefined : options.sinceProjection) ??
      "full";
    const lastRow = result.body.rows.at(-1);
    return {
      kind: "rows",
      rows: result.body.rows,
      cursor:
        result.body.cursor ??
        (lastRow === undefined
          ? options.sinceEventId === null
            ? { lastEventId: null, lastSeqId: 0 }
            : {
                lastEventId: options.sinceEventId,
                lastSeqId: options.sinceSeqId,
                projection,
              }
          : {
              lastEventId: lastRow.id,
              lastSeqId: lastRow.seqId,
              projection,
            }),
      hasMore: result.body.hasMore ?? result.body.rows.length === options.limit,
      schemaVersion: versioned.requestedVersion,
    };
  }
  if (result.status === 410) {
    return {
      kind: "expired",
      schemaVersion: versioned.requestedVersion,
    };
  }
  handleError(result, "Failed to list chat event rows");
}

export async function updateChatThreadModelSelection(options: {
  threadId: string;
  model: string | null;
}): Promise<{ threadId: string; selectedModel: string | null }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadModelSelectionContract, config);
  const model =
    options.model === null ? null : requireSupportedModel(options.model);
  const result = await client.update({
    params: { id: options.threadId },
    body: { model },
  });
  if (result.status === 204) {
    return {
      threadId: options.threadId,
      selectedModel: model,
    };
  }
  handleError(result, "Failed to update chat thread model");
}
