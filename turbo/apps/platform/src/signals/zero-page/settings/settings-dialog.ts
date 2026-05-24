import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { reloadBillingStatus$ } from "../billing.ts";
import { isOrgAdmin$ } from "../../org.ts";
import { initProfileName$ } from "./org-manage-tabs-state.ts";

export const SETTINGS_SECTIONS = [
  "preference",
  "api-keys",
  "model",
  "debug",
  "general",
  "people",
  "billing",
  "usage",
  "invoices",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const ADMIN_ONLY_SETTINGS_SECTIONS_LIST = [
  "general",
  "people",
  "billing",
  "usage",
  "invoices",
] as const satisfies readonly SettingsSection[];

export function isAdminOnlySettingsSection(section: SettingsSection): boolean {
  return (
    ADMIN_ONLY_SETTINGS_SECTIONS_LIST as readonly SettingsSection[]
  ).includes(section);
}

const internalSettingsDialogOpen$ = state(false);
const internalExternalProfileModalOpen$ = state(false);

export const settingsDialogOpen$ = computed((get) => {
  return get(internalSettingsDialogOpen$);
});

export const externalProfileModalOpen$ = computed((get) => {
  return get(internalExternalProfileModalOpen$);
});

export const setExternalProfileModalOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalExternalProfileModalOpen$, open);
  },
);

const internalActiveSection$ = state<SettingsSection>("preference");

export const settingsActiveSection$ = computed((get) => {
  return get(internalActiveSection$);
});

export const setSettingsActiveSection$ = command(
  ({ get, set }, section: SettingsSection) => {
    set(internalActiveSection$, section);
    const params = new URLSearchParams(get(searchParams$));
    if (params.get("settings") !== section) {
      params.set("settings", section);
      set(updateSearchParams$, params);
    }
  },
);

export const setSettingsDialogOpen$ = command(
  async ({ get, set }, open: boolean, signal: AbortSignal) => {
    set(internalSettingsDialogOpen$, open);
    if (open) {
      await set(initProfileName$, signal);
      signal.throwIfAborted();
      set(reloadBillingStatus$);
      const params = new URLSearchParams(get(searchParams$));
      const section = get(internalActiveSection$);
      if (params.get("settings") !== section) {
        params.set("settings", section);
        set(updateSearchParams$, params);
      }
    } else {
      const params = new URLSearchParams(get(searchParams$));
      if (params.has("settings")) {
        params.delete("settings");
        set(updateSearchParams$, params);
      }
    }
  },
);

/**
 * Open the dialog directly on a target section. Used by entry-point components
 * (account dropdown, org switcher) to deep-link into a specific area.
 */
export const openSettingsDialogAt$ = command(
  async ({ set }, section: SettingsSection, signal: AbortSignal) => {
    set(internalActiveSection$, section);
    await set(setSettingsDialogOpen$, true, signal);
  },
);

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Check URL for `?settings=<section>` and auto-open the dialog on that section.
 * Falls back to the closest non-admin section if the user lacks workspace
 * admin and the URL points at an admin-only section. Strips the param from
 * the URL after consuming it so reloads don't re-pin the dialog.
 */
export const checkUnifiedSettingsParam$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const value = params.get("settings");
    if (!value) {
      return;
    }
    if (isSettingsSection(value)) {
      const section = value;
      const isAdmin = await get(isOrgAdmin$);
      signal.throwIfAborted();
      const resolved =
        !isAdmin && isAdminOnlySettingsSection(section)
          ? "preference"
          : section;
      set(internalActiveSection$, resolved);
      await set(setSettingsDialogOpen$, true, signal);
    }

    // Strip the param so a reload doesn't re-pin the dialog on this section
    const next = new URLSearchParams(get(searchParams$));
    next.delete("settings");
    set(updateSearchParams$, next);
  },
);
