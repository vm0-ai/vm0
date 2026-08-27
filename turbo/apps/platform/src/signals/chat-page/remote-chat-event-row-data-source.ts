import { command } from "ccstate";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import {
  assertChatEventSchemaVersion,
  requestWithChatEventSchemaVersionFallback,
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
      readonly schemaVersion: number;
    }
  | { readonly kind: "expired"; readonly schemaVersion: number };

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
    const versioned = await requestWithChatEventSchemaVersionFallback(
      async (headers) => {
        return await client.rows({
          headers,
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
                  ...(cursor.projection === undefined
                    ? {}
                    : { sinceProjection: cursor.projection }),
                  limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
                },
          fetchOptions: { signal },
        });
      },
    );
    signal.throwIfAborted();
    const result = await accept(
      Promise.resolve(versioned.response),
      [200, 410],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    assertChatEventSchemaVersion(result.headers, versioned.requestedVersion);
    if (result.status === 410) {
      L.debug("listRowsAfter$: cursor expired", { threadId, cursor });
      return {
        kind: "expired",
        schemaVersion: versioned.requestedVersion,
      };
    }
    L.debug("listRowsAfter$", {
      threadId,
      cursor,
      count: result.body.rows.length,
    });
    // Old browser cache/new app and new app/old API fallback. Remove with
    // #29362 after legacy caches rebuild, the V6 app floor is live, and the
    // old API leaves rollback.
    const projection =
      result.body.projection ??
      ("projection" in cursor ? cursor.projection : undefined) ??
      "full";
    const lastRow = result.body.rows.at(-1);
    const responseCursor =
      result.body.cursor ??
      (lastRow === undefined
        ? cursor
        : {
            lastEventId: lastRow.id,
            lastSeqId: lastRow.seqId,
            projection,
          });
    return {
      kind: "rows",
      rows: result.body.rows,
      cursor: responseCursor,
      hasMore:
        result.body.hasMore ??
        result.body.rows.length === CHAT_EVENT_ROWS_PAGE_LIMIT,
      schemaVersion: versioned.requestedVersion,
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
    readonly schemaVersion: number;
    readonly snapshot: {
      readonly rows: readonly ChatEventRow[];
      readonly lastEventId: string | null;
      readonly lastSeqId: number;
      readonly projection: "full" | "tool-redacted";
    } | null;
  }> => {
    const client = get(apiClient$)(chatThreadEventsContract);
    const versioned = await requestWithChatEventSchemaVersionFallback(
      async (headers) => {
        return await client.snapshot({
          headers,
          params: { threadId },
          fetchOptions: { signal },
        });
      },
    );
    signal.throwIfAborted();
    const download = await accept(
      Promise.resolve(versioned.response),
      [200, 404],
      signal,
    );
    signal.throwIfAborted();
    assertChatEventSchemaVersion(download.headers, versioned.requestedVersion);
    if (download.status === 404) {
      L.debug("fetchChatEventSnapshotRows$: no snapshot yet", { threadId });
      return {
        schemaVersion: versioned.requestedVersion,
        snapshot: null,
      };
    }
    const response = await fetch(download.body.url, { signal });
    if (!response.ok) {
      throw new Error(
        `chat event snapshot download failed with status ${response.status}`,
      );
    }
    const text = await response.text();
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
    // New app -> old API fallback. Remove with #29362 after the old API leaves
    // rollback and the V6 app client-version floor is live.
    return {
      schemaVersion: versioned.requestedVersion,
      snapshot: {
        rows,
        lastEventId: download.body.lastEventId,
        lastSeqId: download.body.lastSeqId,
        projection: download.body.projection ?? "full",
      },
    };
  },
);
