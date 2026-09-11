import { v5 as uuidv5 } from "uuid";

import { db } from "../lib/db";
import { insertChatEvent } from "../signals/services/chat-event.service";

/**
 * A real client cannot choose a runless assistant event UUID. Occupy the next
 * welcome seed's UUID in another test-owned thread to induce a database failure
 * after thread/connector/lifecycle writes, without mocking transaction code.
 */
export async function occupyWelcomeSeedFixture(
  threadId: string,
  clientThreadId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await insertChatEvent(tx, {
      id: uuidv5(clientThreadId, "6544eaa2-1b91-4b5b-9cb2-d67818de47a7"),
      chatThreadId: threadId,
      eventType: "output.message",
      content: "Test-owned seed UUID collision",
    });
  });
}
