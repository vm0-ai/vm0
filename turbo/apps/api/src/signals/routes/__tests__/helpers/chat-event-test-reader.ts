import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatEventSchema,
  chatThreadEventsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { zeroChatThreadRoutes } from "../../zero-chat-threads";

const MAX_EVENT_ROWS_PER_PAGE = 50;

export function projectChatEventRows(
  rows: readonly ChatEventRow[],
): readonly ChatEvent[] {
  return rows.map((row) => {
    const serialized = JSON.stringify(chatEventFromRow(row));
    if (serialized === undefined) {
      throw new Error(`Failed to serialize chat event ${row.id}`);
    }
    return chatEventSchema.parse(JSON.parse(serialized));
  });
}

export async function readProjectedChatEvents(
  context: TestContext,
  args: {
    readonly threadId: string;
    readonly headers: Readonly<{ authorization?: string }>;
    readonly cursor?: ChatEventCursor;
    readonly limit?: number;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  },
): Promise<readonly ChatEvent[]> {
  const client = setupApp({ context, routes: zeroChatThreadRoutes })(
    chatThreadEventsContract,
  );
  const limit = args.limit ?? MAX_EVENT_ROWS_PER_PAGE;
  const rows: ChatEventRow[] = [];
  let cursor: ChatEventCursor = args.cursor ?? {
    lastEventId: null,
    lastSeqId: 0,
  };

  while (true) {
    const response = await accept(
      client.rows({
        headers: {
          ...args.headers,
          [CHAT_EVENT_SCHEMA_VERSION_HEADER]: String(
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        },
        ...(args.extraHeaders === undefined
          ? {}
          : { extraHeaders: args.extraHeaders }),
        params: { threadId: args.threadId },
        query:
          cursor.lastEventId === null
            ? { sinceSeqId: 0, limit }
            : {
                sinceEventId: cursor.lastEventId,
                sinceSeqId: cursor.lastSeqId,
                limit,
              },
      }),
      [200],
    );
    rows.push(...response.body.rows);
    if (response.body.rows.length < limit) {
      return projectChatEventRows(rows);
    }

    const nextRow = response.body.rows.at(-1);
    if (nextRow === undefined || nextRow.seqId <= cursor.lastSeqId) {
      throw new Error(
        `Chat event row cursor did not advance for ${args.threadId}`,
      );
    }
    cursor = {
      lastEventId: nextRow.id,
      lastSeqId: nextRow.seqId,
    };
  }
}
