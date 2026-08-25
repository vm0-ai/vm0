import { command, computed, state } from "ccstate";

import { onRef } from "./utils.ts";

export const focusAuthV2HeadingRef$ = onRef(
  command(
    (_context, heading: HTMLHeadingElement, signal: AbortSignal): void => {
      signal.throwIfAborted();
      heading.focus();
    },
  ),
);

const revealedAuthV2PasswordFieldIds$ = state<ReadonlySet<string>>(new Set());

export const authV2RevealedPasswordFieldIds$ = computed((get) => {
  return get(revealedAuthV2PasswordFieldIds$);
});

export const setAuthV2PasswordFieldRevealed$ = command(
  ({ get, set }, id: string, revealed: boolean): void => {
    const current = get(revealedAuthV2PasswordFieldIds$);
    if (current.has(id) === revealed) {
      return;
    }
    const next = new Set(current);
    if (revealed) {
      next.add(id);
    } else {
      next.delete(id);
    }
    set(revealedAuthV2PasswordFieldIds$, next);
  },
);

export const resetAuthV2PasswordFieldOnRef$ = onRef(
  command(({ set }, input: HTMLInputElement, signal: AbortSignal): void => {
    signal.addEventListener(
      "abort",
      () => {
        set(setAuthV2PasswordFieldRevealed$, input.id, false);
      },
      { once: true },
    );
  }),
);
