import { command, computed, state } from "ccstate";
import type { ComponentType, ReactNode } from "react";

export type PageLayout = "sidebar" | "minimal" | "none";
export type PageLayoutComponent = ComponentType<{ children: ReactNode }>;

type RegisteredPageLayouts = Partial<
  Record<Exclude<PageLayout, "none">, PageLayoutComponent>
>;

const internalLayout$ = state<PageLayout>("none");
const internalPage$ = state<ReactNode | undefined>(undefined);
const internalPageLayouts$ = state<RegisteredPageLayouts>({});

export const pageLayout$ = computed((get) => {
  return get(internalLayout$);
});

export const page$ = computed((get) => {
  return get(internalPage$);
});

export const pageLayouts$ = computed((get) => {
  return get(internalPageLayouts$);
});

export const registerPageLayout$ = command(
  (
    { get, set },
    layout: Exclude<PageLayout, "none">,
    component: PageLayoutComponent,
  ) => {
    const layouts = get(internalPageLayouts$);
    if (layouts[layout] === component) {
      return;
    }
    set(internalPageLayouts$, { ...layouts, [layout]: component });
  },
);

// Detach the committed page before route-derived state moves to a new location.
export const clearPage$ = command(({ set }) => {
  set(internalPage$, undefined);
});

export const updatePage$ = command(
  ({ set }, page: ReactNode, layout: PageLayout = "none") => {
    set(internalLayout$, layout);
    set(internalPage$, page);
  },
);
