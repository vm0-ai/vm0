import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

type ModelPickerCategory = "chat" | "image" | "video";

type ModelPickerMenuPage =
  | { readonly kind: "overview" }
  | { readonly kind: "models"; readonly category: ModelPickerCategory }
  | { readonly kind: "settings" };

/** One navigation state per composer, including split chats. */
export function createModelPickerMenuSignals() {
  const internalPage$ = state<ModelPickerMenuPage>({ kind: "overview" });
  const page$ = computed((get) => {
    return get(internalPage$);
  });
  const reset$ = command(({ set }) => {
    set(internalPage$, { kind: "overview" });
  });
  const showModels$ = command(({ set }, category: ModelPickerCategory) => {
    set(internalPage$, { kind: "models", category });
  });
  const editSettings$ = command(({ set }) => {
    set(internalPage$, { kind: "settings" });
  });
  const focusPanelRef$ = onRef(
    command((_context, element: HTMLElement, _signal: AbortSignal) => {
      element
        .querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    }),
  );
  return {
    page$,
    reset$,
    showModels$,
    editSettings$,
    focusPanelRef$,
  };
}

export type ModelPickerMenuSignals = ReturnType<
  typeof createModelPickerMenuSignals
>;
