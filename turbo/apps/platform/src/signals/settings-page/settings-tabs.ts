import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

export type SettingsTab =
  | "providers"
  | "connectors"
  | "secrets-and-variables"
  | "integrations";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalActiveTab$ = state<SettingsTab>("providers");

// ---------------------------------------------------------------------------
// Public computed signals
// ---------------------------------------------------------------------------

export const activeTab$ = computed((get) => get(internalActiveTab$));

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function isValidTab(value: string): value is SettingsTab {
  return (
    value === "providers" ||
    value === "connectors" ||
    value === "secrets-and-variables" ||
    value === "integrations"
  );
}

/** Legacy tab values that map to the merged tab. */
function isLegacySecretsOrVariablesTab(value: string): boolean {
  return value === "secrets" || value === "variables";
}

/**
 * Initialize tab state from URL search params.
 * Called during settings page setup.
 */
export const initSettingsTabs$ = command(({ get, set }) => {
  const params = get(searchParams$);

  const tab = params.get("tab");
  if (tab) {
    if (isValidTab(tab)) {
      set(internalActiveTab$, tab);
    } else if (isLegacySecretsOrVariablesTab(tab)) {
      set(internalActiveTab$, "secrets-and-variables");
    }
  }
});

/**
 * Switch active tab and sync to URL.
 */
export const setActiveTab$ = command(({ get, set }, tab: SettingsTab) => {
  set(internalActiveTab$, tab);

  const params = new URLSearchParams(get(searchParams$));
  if (tab === "providers") {
    params.delete("tab");
  } else {
    params.set("tab", tab);
  }
  set(updateSearchParams$, params);
});
