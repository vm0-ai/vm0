import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { pathname$, searchParams$, updateSearchParams$ } from "../../route.ts";
import { onRef } from "../../utils.ts";

export const connectorDirectoryEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ConnectorDirectory] === true;
});

export const connectorDirectoryCustomScope$ = computed((get) => {
  return (
    get(connectorDirectoryEnabled$) &&
    get(searchParams$).get("tab") === "custom"
  );
});

type DirectoryScope =
  | { readonly kind: "all" }
  | { readonly kind: "custom" }
  | { readonly kind: "category"; readonly category: string };

const createdConnectorId$ = state<string | null>(null);

export const openConnectorDirectoryScope$ = command(
  ({ get, set }, scope: DirectoryScope) => {
    const params = new URLSearchParams(get(searchParams$));
    params.delete("connection");
    params.delete("tab");
    params.delete("category");
    if (scope.kind === "custom") {
      params.set("tab", "custom");
    } else if (scope.kind === "category") {
      params.set("category", scope.category);
    }
    set(createdConnectorId$, null);
    set(updateSearchParams$, params);
  },
);

export const showCreatedDirectoryConnector$ = command(
  ({ get, set }, connectorId: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set("tab", "custom");
    params.delete("category");
    params.delete("keywords");
    params.delete("connection");
    set(createdConnectorId$, connectorId);
    set(updateSearchParams$, params);
  },
);

export const focusCreatedDirectoryConnector$ = onRef(
  command(({ get, set }, element: HTMLDivElement, _signal: AbortSignal) => {
    if (
      get(connectorDirectoryEnabled$) &&
      get(pathname$) === "/connectors" &&
      element.dataset.customConnectorId === get(createdConnectorId$)
    ) {
      element.scrollIntoView({ block: "nearest" });
      element.focus({ preventScroll: true });
      set(createdConnectorId$, null);
    }
  }),
);
