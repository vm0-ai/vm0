import { command, computed, state } from "ccstate";
import type { ReactNode } from "react";

const internalPage$ = state<ReactNode | undefined>(undefined);

export const page$ = computed((get) => {
  return get(internalPage$);
});

export const updatePage$ = command(({ set }, page: ReactNode) => {
  set(internalPage$, page);
});
