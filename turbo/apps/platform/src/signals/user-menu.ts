import { command, computed, state } from "ccstate";

/**
 * Internal state for user menu open/close
 */
const internalUserMenuOpen$ = state(false);

/**
 * Current user menu open state
 */
export const userMenuOpen$ = computed((get) => get(internalUserMenuOpen$));

/**
 * Toggle user menu open/close
 */
export const toggleUserMenu$ = command(({ get, set }) => {
  const current = get(internalUserMenuOpen$);
  set(internalUserMenuOpen$, !current);
});

/**
 * Close user menu
 */
export const closeUserMenu$ = command(({ set }) => {
  set(internalUserMenuOpen$, false);
});
