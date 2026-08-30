import { logger } from "../log.ts";

const L = logger("ChatIdbCache");

class ChatIdbDisabledError extends Error {
  constructor(dbName: string) {
    super(`IndexedDB disabled for this session: ${dbName}`);
    this.name = "ChatIdbDisabledError";
  }
}

export function disabledChatIdbError(dbName: string): Error {
  return new ChatIdbDisabledError(dbName);
}

export function logChatIdbDisabled(dbName: string, reason: unknown): void {
  L.warn("disableForSession", { dbName, reason });
}
