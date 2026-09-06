import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

type ModelPickerCategory = "chat" | "image" | "video";

type ModelPickerMenuPage =
  | { readonly kind: "overview" }
  | { readonly kind: "models"; readonly category: ModelPickerCategory }
  | {
      readonly kind: "settings";
      readonly selection: ModelProviderSelection;
      readonly from: "overview" | "models";
    };

/** One navigation and unconfirmed draft per composer, including split chats. */
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
  const editSettings$ = command(
    (
      { set },
      selection: ModelProviderSelection,
      from: "overview" | "models",
    ) => {
      set(internalPage$, { kind: "settings", selection, from });
    },
  );
  const setFast$ = command(({ get, set }, fast: boolean) => {
    const page = get(internalPage$);
    if (page.kind === "settings") {
      set(internalPage$, {
        ...page,
        selection: {
          selectedModel: page.selection.selectedModel,
          ...(fast ? { codexServiceTier: "fast" } : {}),
        },
      });
    }
  });
  const back$ = command(({ get, set }) => {
    const page = get(internalPage$);
    set(
      internalPage$,
      page.kind === "settings" && page.from === "models"
        ? { kind: "models", category: "chat" }
        : { kind: "overview" },
    );
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
    setFast$,
    back$,
    focusPanelRef$,
  };
}

export type ModelPickerMenuSignals = ReturnType<
  typeof createModelPickerMenuSignals
>;
