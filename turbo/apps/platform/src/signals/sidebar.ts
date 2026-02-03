import { command, computed, state } from "ccstate";

/**
 * Internal state for sidebar collapsed/expanded (desktop).
 */
const internalSidebarCollapsed$ = state(false);

/**
 * Internal state for mobile sidebar open/closed.
 */
const internalMobileSidebarOpen$ = state(false);

/**
 * Current sidebar collapsed state (desktop).
 */
export const sidebarCollapsed$ = computed((get) =>
  get(internalSidebarCollapsed$),
);

/**
 * Current mobile sidebar open state.
 */
export const mobileSidebarOpen$ = computed((get) =>
  get(internalMobileSidebarOpen$),
);

/**
 * Toggle sidebar between collapsed and expanded (desktop).
 */
export const toggleSidebar$ = command(({ get, set }) => {
  const current = get(internalSidebarCollapsed$);
  const newValue = !current;
  set(internalSidebarCollapsed$, newValue);

  // Persist to localStorage
  localStorage.setItem("sidebar-collapsed", String(newValue));
});

/**
 * Toggle mobile sidebar open/closed.
 */
export const toggleMobileSidebar$ = command(({ get, set }) => {
  const current = get(internalMobileSidebarOpen$);
  set(internalMobileSidebarOpen$, !current);
});

/**
 * Close mobile sidebar.
 */
export const closeMobileSidebar$ = command(({ set }) => {
  set(internalMobileSidebarOpen$, false);
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
