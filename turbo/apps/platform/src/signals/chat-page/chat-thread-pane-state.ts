import { command, computed, state } from "ccstate";

import type { ChatPanelSignals } from "./chat-panel-signals.ts";

const internalLeftThread$ = state<ChatPanelSignals | null>(null);
const internalRightThread$ = state<ChatPanelSignals | null>(null);
// Pane references stay mounted across route setup; these flags mirror whether
// the referenced panel's owner signal is still active.
const internalLeftThreadActive$ = state(false);
const internalRightThreadActive$ = state(false);

export const currentLeftThread$ = computed((get): ChatPanelSignals | null => {
  return get(internalLeftThread$);
});

export const currentRightThread$ = computed((get): ChatPanelSignals | null => {
  return get(internalRightThread$);
});

export const currentLeftThreadActive$ = computed((get): boolean => {
  return get(internalLeftThreadActive$);
});

export const currentRightThreadActive$ = computed((get): boolean => {
  return get(internalRightThreadActive$);
});

export const setCurrentLeftThread$ = command(
  ({ set }, thread: ChatPanelSignals | null) => {
    set(internalLeftThread$, thread);
  },
);

export const setCurrentRightThread$ = command(
  ({ set }, thread: ChatPanelSignals | null) => {
    set(internalRightThread$, thread);
  },
);

export const setCurrentLeftThreadActive$ = command(
  ({ set }, active: boolean) => {
    set(internalLeftThreadActive$, active);
  },
);

export const setCurrentRightThreadActive$ = command(
  ({ set }, active: boolean) => {
    set(internalRightThreadActive$, active);
  },
);
