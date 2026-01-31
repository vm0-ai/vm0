import { command, computed, state } from "ccstate";

/**
 * Internal state for sidebar collapsed/expanded.
 */
const internalSidebarCollapsed$ = state(false);

/**
 * Current sidebar collapsed state.
 */
export const sidebarCollapsed$ = computed((get) =>
  get(internalSidebarCollapsed$),
);

/**
 * Toggle sidebar between collapsed and expanded.
 */
export const toggleSidebar$ = command(({ get, set }) => {
  const current = get(internalSidebarCollapsed$);
  const newValue = !current;
  set(internalSidebarCollapsed$, newValue);

  // Persist to localStorage
  localStorage.setItem("sidebar-collapsed", String(newValue));
});

/**
 * Initialize sidebar state from localStorage.
 */
export const initSidebar$ = command(({ set }) => {
  const stored = localStorage.getItem("sidebar-collapsed");

  if (stored === "true") {
    set(internalSidebarCollapsed$, true);
  }
  // Default is false (expanded), no need to set explicitly
});
