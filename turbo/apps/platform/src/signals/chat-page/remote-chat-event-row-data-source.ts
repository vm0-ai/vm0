import { command } from "ccstate";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  LEGACY_CHAT_EVENT_PROJECTION,
  withoutLegacyChatEventProjection,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import {
  assertChatEventSchemaVersion,
  CHAT_EVENT_SCHEMA_VERSION_HEADERS,
} from "../../shared-database/chat-event-schema-version.ts";
import { apiClient$ } from "../api-client.ts";
import { logger } from "../log.ts";

const L = logger("ChatEventRowRemote");
export const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;

type ChatEventRowsPage =
  | {
      readonly kind: "rows";
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
      readonly hasMore: boolean;
    }
  | { readonly kind: "expired" };

export const listRowsAfter$ = command(
  async (
    { get },
    {
      threadId,
      cursor,
    }: { readonly threadId: string; readonly cursor: ChatEventCursor },
    signal: AbortSignal,
  ): Promise<ChatEventRowsPage> => {
    const client = get(apiClient$)(chatThreadEventsContract);
    const response = await client.rows({
      headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
      params: { threadId },
      query:
        cursor.lastEventId === null
          ? {
              sinceSeqId: cursor.lastSeqId,
              limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
            }
          : {
              sinceSeqId: cursor.lastSeqId,
              sinceEventId: cursor.lastEventId,
              // Keep new App builds compatible with the pre-Stage-1 API.
              sinceProjection: LEGACY_CHAT_EVENT_PROJECTION,
              limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
            },
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    const result = await accept(Promise.resolve(response), [200, 410], signal, {
      showErrorToast: false,
    });
    signal.throwIfAborted();
    assertChatEventSchemaVersion(result.headers);
    if (result.status === 410) {
      L.debug("listRowsAfter$: cursor expired", { threadId, cursor });
      return { kind: "expired" };
    }
    L.debug("listRowsAfter$", {
      threadId,
      cursor,
      count: result.body.rows.length,
    });
    return {
      kind: "rows",
      rows: result.body.rows,
      cursor: withoutLegacyChatEventProjection(result.body.cursor),
      hasMore: result.body.hasMore,
    };
  },
);

/**
 * Cold start: resolve the thread's snapshot download and pull the archive
 * body. The object is stored with `Content-Encoding: gzip`, so the browser
 * network stack hands back plain NDJSON text. A thread the archiver has not
 * reached yet has no snapshot, which is a normal 404 rather than an error:
 * the caller then reads the whole thread from the raw-row endpoint.
 */
export const fetchChatEventSnapshotRows$ = command(
  async (
    { get },
    threadId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly snapshot: {
      readonly rows: readonly ChatEventRow[];
      readonly lastEventId: string | null;
      readonly lastSeqId: number;
    } | null;
  }> => {
    const client = get(apiClient$)(chatThreadEventsContract);
    const response = await client.snapshot({
      headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
      params: { threadId },
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    const download = await accept(
      Promise.resolve(response),
      [200, 404],
      signal,
    );
    signal.throwIfAborted();
    assertChatEventSchemaVersion(download.headers);
    if (download.status === 404) {
      L.debug("fetchChatEventSnapshotRows$: no snapshot yet", { threadId });
      return { snapshot: null };
    }
    const snapshotResponse = await fetch(download.body.url, { signal });
    if (!snapshotResponse.ok) {
      throw new Error(
        `chat event snapshot download failed with status ${snapshotResponse.status}`,
      );
    }
    const text = await snapshotResponse.text();
    signal.throwIfAborted();
    if (text.length > 0 && !text.endsWith("\n")) {
      throw new Error("chat event snapshot must be newline-delimited JSON");
    }
    const rows =
      text.length === 0
        ? []
        : text
            .slice(0, -1)
            .split("\n")
            .map((line) => {
              return chatEventRowSchema.parse(JSON.parse(line));
            });
    L.debug("fetchChatEventSnapshotRows$", {
      threadId,
      count: rows.length,
      lastSeqId: download.body.lastSeqId,
    });
    return {
      snapshot: {
        rows,
        lastEventId: download.body.lastEventId,
        lastSeqId: download.body.lastSeqId,
      },
    };
  },
);
