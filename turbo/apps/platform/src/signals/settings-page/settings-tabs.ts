import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

export type SettingsTab = "providers" | "connections" | "integrations";

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
    value === "providers" || value === "connections" || value === "integrations"
  );
}

/** Legacy tab values that map to the Connections tab. */
function isLegacyConnectionsTab(value: string): boolean {
  return (
    value === "connectors" ||
    value === "connectors-and-secrets" ||
    value === "secrets-and-variables" ||
    value === "secrets" ||
    value === "variables"
  );
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
    } else if (isLegacyConnectionsTab(tab)) {
      set(internalActiveTab$, "connections");
    } else if (tab === "notifications") {
      // Notifications moved to /preferences; fall back to default tab.
      set(internalActiveTab$, "providers");
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
