import { createElement, type ReactNode } from "react";
import { createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";

export const appStore = createStore();

export function AppStoreProvider({ children }: { children: ReactNode }) {
  return createElement(StoreProvider, { value: appStore }, children);
}
