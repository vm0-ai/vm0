import { command } from "ccstate";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";

const L = logger("ChatEventRowRemote");
export const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;

const CHAT_EVENT_SCHEMA_VERSION_HEADERS = Object.freeze({
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
    CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
});

function assertChatEventSchemaVersion(headers: Headers): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  // Old API deployments do not echo the header during the rollout overlap.
  if (
    version !== null &&
    version !== CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()
  ) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}

type ChatEventRowsPage =
  | { readonly kind: "rows"; readonly rows: readonly ChatEventRow[] }
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
    const client = get(zeroClient$)(chatThreadEventsContract);
    const result = await accept(
      client.rows({
        headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
        params: { threadId },
        query: {
          sinceSeqId: cursor.lastSeqId,
          sinceEventId: cursor.lastEventId ?? undefined,
          limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
        },
        fetchOptions: { signal },
      }),
      [200, 410],
      signal,
      { showErrorToast: false },
    );
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
    return { kind: "rows", rows: result.body.rows };
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
    readonly rows: readonly ChatEventRow[];
    readonly lastEventId: string | null;
    readonly lastSeqId: number;
  } | null> => {
    const client = get(zeroClient$)(chatThreadEventsContract);
    const download = await accept(
      client.snapshot({
        headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
        params: { threadId },
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
    );
    signal.throwIfAborted();
    assertChatEventSchemaVersion(download.headers);
    if (download.status === 404) {
      L.debug("fetchChatEventSnapshotRows$: no snapshot yet", { threadId });
      return null;
    }

    const response = await fetch(download.body.url, { signal });
    if (!response.ok) {
      throw new Error(
        `chat event snapshot download failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    signal.throwIfAborted();
    if (text.length === 0 || !text.endsWith("\n")) {
      throw new Error("chat event snapshot must be newline-delimited JSON");
    }
    const rows = text
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
      rows,
      lastEventId: download.body.lastEventId ?? rows.at(-1)?.id ?? null,
      lastSeqId: download.body.lastSeqId,
    };
  },
);
