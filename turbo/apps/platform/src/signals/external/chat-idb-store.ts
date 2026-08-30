import type { IDBPDatabase } from "idb";
import { computed } from "ccstate";
import { authenticatedIdentity$ } from "../auth.ts";
import { createChatIdbOpener } from "./chat-idb-opener.ts";

// Page-side entry point for the chat database. It depends on the browser auth
// signals, so the shared database worker imports ./chat-idb-opener.ts instead.
const defaultChatIdbOpener = createChatIdbOpener({
  reload: () => {
    window.location.reload();
  },
});

export const openChatIdb = defaultChatIdbOpener.openChatIdb;

export const chatIdb$ = computed(async (get): Promise<IDBPDatabase> => {
  const { userId, orgId } = await get(authenticatedIdentity$);
  return openChatIdb(userId, orgId);
});
