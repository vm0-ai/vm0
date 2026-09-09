import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

type ModelPickerCategory = "chat" | "image" | "video";

type ModelPickerMenuPage =
  | { readonly kind: "overview" }
  | { readonly kind: "models"; readonly category: ModelPickerCategory }
  | { readonly kind: "settings" };

/** Which side of the root panel the flyout has room to open towards. */
type ModelPickerFlyoutSide = "left" | "right";

const FLYOUT_PANEL_WIDTH = 258;

/** One navigation state per composer, including split chats. */
export function createModelPickerMenuSignals() {
  const internalPage$ = state<ModelPickerMenuPage>({ kind: "overview" });
  const page$ = computed((get) => {
    return get(internalPage$);
  });
  const reset$ = command(({ set }) => {
    set(internalPage$, { kind: "overview" });
    set(internalFlyoutCategory$, "chat");
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

  // The flyout keeps its own category rather than reusing the drill-in page:
  // hovering a type must not push a navigation entry the user has to unwind.
  const internalFlyoutCategory$ = state<ModelPickerCategory>("chat");
  const flyoutCategory$ = computed((get) => {
    return get(internalFlyoutCategory$);
  });
  const setFlyoutCategory$ = command(
    ({ set }, category: ModelPickerCategory) => {
      set(internalFlyoutCategory$, category);
    },
  );

  const internalFlyoutSide$ = state<ModelPickerFlyoutSide>("left");
  const flyoutSide$ = computed((get) => {
    return get(internalFlyoutSide$);
  });
  /**
   * Open the panel towards whichever side actually has room. Measured from the
   * anchored root, so the root itself never moves when the panel flips.
   */
  const flyoutRootRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      const measure = () => {
        const box = element.getBoundingClientRect();
        const roomRight = window.innerWidth - box.right;
        const roomLeft = box.left;
        set(
          internalFlyoutSide$,
          roomRight >= FLYOUT_PANEL_WIDTH || roomRight >= roomLeft
            ? "right"
            : "left",
        );
      };
      measure();
      window.addEventListener("resize", measure);
      signal.addEventListener("abort", () => {
        window.removeEventListener("resize", measure);
      });
    }),
  );

  /** Land on the current model, not on whatever renders first. */
  const focusFlyoutPanelRef$ = onRef(
    command((_context, element: HTMLElement, _signal: AbortSignal) => {
      const selected = element.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]',
      );
      (
        selected ?? element.querySelector<HTMLButtonElement>('[role="option"]')
      )?.focus();
    }),
  );

  return {
    page$,
    reset$,
    showModels$,
    editSettings$,
    focusPanelRef$,
    flyoutCategory$,
    setFlyoutCategory$,
    flyoutSide$,
    flyoutRootRef$,
    focusFlyoutPanelRef$,
  };
}

export type ModelPickerMenuSignals = ReturnType<
  typeof createModelPickerMenuSignals
>;
