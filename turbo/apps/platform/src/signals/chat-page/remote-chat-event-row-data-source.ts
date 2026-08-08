import { command } from "ccstate";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@vm0/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";

const L = logger("ChatEventRowRemote");
export const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;

type ChatEventRowsPage =
  | { readonly kind: "rows"; readonly rows: readonly ChatEventRow[] }
  | { readonly kind: "expired" };

export const listRowsAfter$ = command(
  async (
    { get },
    {
      threadId,
      sinceSeqId,
    }: { readonly threadId: string; readonly sinceSeqId: number },
    signal: AbortSignal,
  ): Promise<ChatEventRowsPage> => {
    const client = get(zeroClient$)(chatThreadEventsContract);
    const result = await accept(
      client.rows({
        params: { threadId },
        query: { sinceSeqId, limit: CHAT_EVENT_ROWS_PAGE_LIMIT },
        fetchOptions: { signal },
      }),
      [200, 410],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    if (result.status === 410) {
      L.debug("listRowsAfter$: cursor expired", { threadId, sinceSeqId });
      return { kind: "expired" };
    }
    L.debug("listRowsAfter$", {
      threadId,
      sinceSeqId,
      count: result.body.rows.length,
    });
    return { kind: "rows", rows: result.body.rows };
  },
);

/**
 * Cold start: resolve the thread's snapshot download and pull the archive
 * body. The object is stored with `Content-Encoding: gzip`, so the browser
 * network stack hands back plain NDJSON text.
 */
export const fetchChatEventSnapshotRows$ = command(
  async (
    { get },
    threadId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly rows: readonly ChatEventRow[];
    readonly lastSeqId: number;
  }> => {
    const client = get(zeroClient$)(chatThreadEventsContract);
    const download = await accept(
      client.snapshot({
        params: { threadId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();

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
    return { rows, lastSeqId: download.body.lastSeqId };
  },
);
