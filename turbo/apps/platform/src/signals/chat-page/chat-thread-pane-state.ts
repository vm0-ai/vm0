import { command, computed, state } from "ccstate";

import type { ChatPanelSignals } from "./chat-panel-signals.ts";

export type ChatThreadPaneState =
  | {
      readonly kind: "thread";
      readonly thread: ChatPanelSignals;
    }
  | {
      readonly kind: "not-found";
      readonly threadId: string;
    }
  | null;

const internalLeftPane$ = state<ChatThreadPaneState>(null);
const internalRightPane$ = state<ChatThreadPaneState>(null);

export const currentLeftPane$ = computed((get): ChatThreadPaneState => {
  return get(internalLeftPane$);
});

export const currentRightPane$ = computed((get): ChatThreadPaneState => {
  return get(internalRightPane$);
});

export const currentLeftThread$ = computed((get): ChatPanelSignals | null => {
  const pane = get(internalLeftPane$);
  return pane?.kind === "thread" ? pane.thread : null;
});

export const currentRightThread$ = computed((get): ChatPanelSignals | null => {
  const pane = get(internalRightPane$);
  return pane?.kind === "thread" ? pane.thread : null;
});

export const setCurrentLeftPane$ = command(
  ({ set }, pane: ChatThreadPaneState) => {
    set(internalLeftPane$, pane);
  },
);

export const setCurrentRightPane$ = command(
  ({ set }, pane: ChatThreadPaneState) => {
    set(internalRightPane$, pane);
  },
);
