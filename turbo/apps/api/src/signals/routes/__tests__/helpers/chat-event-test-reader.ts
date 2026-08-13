import { chatEventFromRow } from "@vm0/api-contracts/contracts/chat-event-row-projection";
import {
  chatThreadEventsContract,
  type ChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { zeroChatThreadRoutes } from "../../zero-chat-threads";

export async function readProjectedChatEvents(
  context: TestContext,
  args: {
    readonly threadId: string;
    readonly headers: Readonly<{ authorization?: string }>;
    readonly sinceSeqId?: number;
    readonly limit?: number;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  },
): Promise<readonly ChatEvent[]> {
  const client = setupApp({ context, routes: zeroChatThreadRoutes })(
    chatThreadEventsContract,
  );
  const response = await accept(
    client.rows({
      headers: args.headers,
      ...(args.extraHeaders === undefined
        ? {}
        : { extraHeaders: args.extraHeaders }),
      params: { threadId: args.threadId },
      query: {
        sinceSeqId: args.sinceSeqId ?? 0,
        limit: args.limit ?? 50,
      },
    }),
    [200],
  );
  return response.body.rows.map(chatEventFromRow);
}
