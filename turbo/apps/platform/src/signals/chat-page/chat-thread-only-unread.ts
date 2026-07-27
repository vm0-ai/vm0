import { command, computed, state } from "ccstate";

const internalChatThreadOnlyUnread$ = state(false);

export const chatThreadOnlyUnread$ = computed((get) => {
  return get(internalChatThreadOnlyUnread$);
});

export const setChatThreadOnlyUnread$ = command(
  ({ set }, onlyUnread: boolean) => {
    set(internalChatThreadOnlyUnread$, onlyUnread);
  },
);
