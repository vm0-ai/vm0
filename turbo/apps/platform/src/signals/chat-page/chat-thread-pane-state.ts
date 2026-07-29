import { command, computed, state } from "ccstate";

import type { ChatThreadSignals } from "./chat-thread-signals.ts";

const internalLeftThread$ = state<ChatThreadSignals | null>(null);
const internalRightThread$ = state<ChatThreadSignals | null>(null);

export const currentLeftThread$ = computed((get): ChatThreadSignals | null => {
  return get(internalLeftThread$);
});

export const currentRightThread$ = computed((get): ChatThreadSignals | null => {
  return get(internalRightThread$);
});

export const setCurrentLeftThread$ = command(
  ({ set }, thread: ChatThreadSignals | null) => {
    set(internalLeftThread$, thread);
  },
);

export const setCurrentRightThread$ = command(
  ({ set }, thread: ChatThreadSignals | null) => {
    set(internalRightThread$, thread);
  },
);
