import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { reloadBillingStatus$ } from "../billing.ts";
import { isOrgAdmin$ } from "../../org.ts";
import {
  initProfileName$,
  setActiveOrgManageTab$,
  setBillingScrollTarget$,
  setBillingSubPage$,
  type OrgManageTab,
} from "./org-manage-tabs-state.ts";
import { setOrgManageDialogOpen$ } from "./org-manage-dialog.ts";

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
type OrgManageOnlySettingsSection = "providers";
type UnifiedSettingsSection = SettingsSection | OrgManageOnlySettingsSection;

// `usage` (Credit balance) is intentionally not admin-only: it holds personal
// usage that every member can see. The team layer inside it is gated separately.
const ADMIN_ONLY_SETTINGS_SECTIONS_LIST = [
  "general",
  "people",
  "billing",
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
      if (params.has("settings") || params.has("billingView")) {
        params.delete("settings");
        params.delete("billingView");
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

function isUnifiedSettingsSection(
  value: string,
): value is UnifiedSettingsSection {
  return isSettingsSection(value) || value === "providers";
}

function orgManageTabForSettingsSection(
  section: UnifiedSettingsSection,
): OrgManageTab | null {
  switch (section) {
    case "general": {
      return "general";
    }
    case "people": {
      return "members";
    }
    case "providers": {
      return "providers";
    }
    case "billing": {
      return "billing";
    }
    case "usage": {
      return "usage";
    }
    case "invoices": {
      return "invoices";
    }
    default: {
      return null;
    }
  }
}

/**
 * Check URL for `?settings=<section>` and auto-open the matching settings
 * surface. Admin-only workspace sections open the workspace management dialog
 * for admins, and fall back to the closest non-admin section otherwise.
 * Valid settings params stay in the URL while the dialog is open; closing the
 * dialog clears them.
 */
export const checkUnifiedSettingsParam$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const value = params.get("settings");
    const billingView = params.get("billingView");
    if (!value) {
      return;
    }
    if (!isUnifiedSettingsSection(value)) {
      const next = new URLSearchParams(get(searchParams$));
      next.delete("settings");
      next.delete("billingView");
      set(updateSearchParams$, next);
      return;
    }

    const section = value;
    const opensBillingPlans = section === "billing" && billingView === "plans";
    const opensBuyCredits = section === "billing" && billingView === "credits";
    const isAdmin = await get(isOrgAdmin$);
    signal.throwIfAborted();

    const orgManageTab = orgManageTabForSettingsSection(section);
    if (orgManageTab && isAdmin) {
      set(setActiveOrgManageTab$, orgManageTab);
      set(setBillingSubPage$, opensBillingPlans);
      set(setBillingScrollTarget$, opensBuyCredits ? "buy-credits" : null);
      await set(setOrgManageDialogOpen$, true, signal);
      return;
    }
    if (!isAdmin && (opensBillingPlans || opensBuyCredits)) {
      set(setBillingSubPage$, false);
      set(setBillingScrollTarget$, null);
      const next = new URLSearchParams(get(searchParams$));
      next.delete("settings");
      next.delete("billingView");
      set(updateSearchParams$, next);
      return;
    }

    const resolved: SettingsSection =
      !isSettingsSection(section) ||
      (!isAdmin && isAdminOnlySettingsSection(section))
        ? "preference"
        : section;
    set(internalActiveSection$, resolved);
    set(setBillingSubPage$, opensBillingPlans && resolved === "billing");
    set(
      setBillingScrollTarget$,
      opensBuyCredits && resolved === "billing" ? "buy-credits" : null,
    );
    await set(setSettingsDialogOpen$, true, signal);
  },
);
