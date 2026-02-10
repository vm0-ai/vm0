import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

export type SettingsTab = "providers" | "connectors" | "secrets" | "variables";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalActiveTab$ = state<SettingsTab>("providers");
const internalRequiredItems$ = state<string[]>([]);

// ---------------------------------------------------------------------------
// Public computed signals
// ---------------------------------------------------------------------------

export const activeTab$ = computed((get) => get(internalActiveTab$));

export const requiredItems$ = computed((get) => get(internalRequiredItems$));

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function isValidTab(value: string): value is SettingsTab {
  return (
    value === "providers" ||
    value === "connectors" ||
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
  if (tab && isValidTab(tab)) {
    set(internalActiveTab$, tab as SettingsTab);
  }

  const required = params.get("required");
  if (required) {
    set(
      internalRequiredItems$,
      required
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
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
