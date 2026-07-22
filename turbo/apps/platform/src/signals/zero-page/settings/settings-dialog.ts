import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { reloadBillingStatus$ } from "../billing.ts";
import { isOrgAdmin$ } from "../../org.ts";
import { reloadPersonalModelProviders$ } from "../../external/personal-model-providers.ts";
import { resetSignal } from "../../utils.ts";
import {
  clearPendingLogo$,
  initProfileName$,
  setBillingScrollTarget$,
  setBillingSubPage$,
} from "./workspace-settings-state.ts";

export const SETTINGS_SECTIONS = [
  "preference",
  "model",
  "debug",
  "general",
  "people",
  "billing",
  "usage",
  "invoices",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
type LegacySettingsSection = "providers";
type UnifiedSettingsSection = SettingsSection | LegacySettingsSection;

// `usage` stays visible to everyone. The rendered label and detail UI depend
// on org role and feature switches.
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
const internalSettingsDialogSignal$ = state<AbortSignal | null>(null);
const resetSettingsDialogSignal$ = resetSignal();
const internalSettingsDialogSessionActive$ = state(false);
const internalSettingsDialogInitialized$ = state(false);
const internalSettingsDialogHandoffPending$ = state(false);
const internalExternalProfileModalOpen$ = state(false);
const pendingAccountMenuSettingsSection$ = state<{
  readonly ownerId: string;
  readonly section: SettingsSection;
} | null>(null);

export const settingsDialogOpen$ = computed((get) => {
  return get(internalSettingsDialogOpen$);
});

export { internalSettingsDialogSignal$ as settingsDialogSignal$ };

export const externalProfileModalOpen$ = computed((get) => {
  return get(internalExternalProfileModalOpen$);
});

export const setExternalProfileModalOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalExternalProfileModalOpen$, open);
  },
);

export const setPendingAccountMenuSettingsSection$ = command(
  ({ get, set }, ownerId: string, section: SettingsSection | null) => {
    if (section === null) {
      const pending = get(pendingAccountMenuSettingsSection$);
      if (pending?.ownerId === ownerId) {
        set(pendingAccountMenuSettingsSection$, null);
      }
      return;
    }
    set(pendingAccountMenuSettingsSection$, { ownerId, section });
  },
);

export const consumePendingAccountMenuSettingsSection$ = command(
  ({ get, set }, ownerId: string) => {
    const pending = get(pendingAccountMenuSettingsSection$);
    const section = pending?.ownerId === ownerId ? pending.section : null;
    if (section !== null) {
      set(pendingAccountMenuSettingsSection$, null);
    }
    return section;
  },
);

const internalActiveSection$ = state<SettingsSection>("preference");

export const settingsActiveSection$ = computed((get) => {
  return get(internalActiveSection$);
});

export const setSettingsActiveSection$ = command(
  ({ get, set }, section: SettingsSection) => {
    set(internalActiveSection$, section);
    if (section === "model") {
      set(reloadPersonalModelProviders$);
    }
    const params = new URLSearchParams(get(searchParams$));
    if (params.get("settings") !== section) {
      params.set("settings", section);
      set(updateSearchParams$, params);
    }
  },
);

export const openSettingsBillingPlans$ = command(({ get, set }) => {
  set(internalActiveSection$, "billing");
  set(setBillingSubPage$, true);
  set(setBillingScrollTarget$, null);

  const params = new URLSearchParams(get(searchParams$));
  params.set("settings", "billing");
  params.set("billingView", "plans");
  set(updateSearchParams$, params);
});

const releaseSettingsDialogSession$ = command(({ get, set }) => {
  set(internalSettingsDialogSignal$, null);
  set(internalSettingsDialogSessionActive$, false);
  set(clearPendingLogo$);

  const handoffPending = get(internalSettingsDialogHandoffPending$);
  set(internalSettingsDialogHandoffPending$, false);
  if (!handoffPending) {
    set(internalSettingsDialogOpen$, false);
    set(internalSettingsDialogInitialized$, false);
  }
});

const clearSettingsDialogSession$ = command(({ set }) => {
  set(releaseSettingsDialogSession$);
  set(internalSettingsDialogOpen$, false);
  set(internalSettingsDialogInitialized$, false);
  set(internalSettingsDialogHandoffPending$, false);
});

export const handoffSettingsDialogSession$ = command(({ set }) => {
  set(internalSettingsDialogHandoffPending$, true);
});

export const closeSettingsModal$ = command(({ get, set }) => {
  set(resetSettingsDialogSignal$);
  set(clearSettingsDialogSession$);

  const params = new URLSearchParams(get(searchParams$));
  if (params.has("settings") || params.has("billingView")) {
    params.delete("settings");
    params.delete("billingView");
    set(updateSearchParams$, params);
  }
});

export const setSettingsDialogOpen$ = command(
  async ({ get, set }, open: boolean, pageSignal: AbortSignal) => {
    if (!open) {
      set(closeSettingsModal$);
      return;
    }

    if (get(internalSettingsDialogSessionActive$)) {
      set(setSettingsActiveSection$, get(internalActiveSection$));
      return;
    }

    const dialogInitialized = get(internalSettingsDialogInitialized$);
    const modalSignal = set(resetSettingsDialogSignal$, pageSignal);
    modalSignal.addEventListener(
      "abort",
      () => {
        set(releaseSettingsDialogSession$);
      },
      { once: true },
    );
    set(internalSettingsDialogSignal$, modalSignal);
    set(internalSettingsDialogSessionActive$, true);
    set(internalSettingsDialogOpen$, true);
    if (!dialogInitialized) {
      await set(initProfileName$, modalSignal);
      pageSignal.throwIfAborted();
      modalSignal.throwIfAborted();
      set(reloadBillingStatus$);
      set(internalSettingsDialogInitialized$, true);
    }
    const params = new URLSearchParams(get(searchParams$));
    const section = get(internalActiveSection$);
    if (section === "model") {
      set(reloadPersonalModelProviders$);
    }
    if (params.get("settings") !== section) {
      params.set("settings", section);
      set(updateSearchParams$, params);
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

function settingsSectionFromParam(
  section: UnifiedSettingsSection,
): SettingsSection {
  return section === "providers" ? "model" : section;
}

/**
 * Check URL for `?settings=<section>` and auto-open the matching settings
 * surface. The legacy `providers` value remains an alias for `model` so old
 * links keep opening the unified settings dialog.
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

    const section = settingsSectionFromParam(value);
    const opensBillingPlans = section === "billing" && billingView === "plans";
    const opensBuyCredits = section === "billing" && billingView === "credits";
    const isAdmin = await get(isOrgAdmin$);
    signal.throwIfAborted();
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
      !isAdmin && isAdminOnlySettingsSection(section) ? "preference" : section;
    set(internalActiveSection$, resolved);
    set(setBillingSubPage$, opensBillingPlans && resolved === "billing");
    set(
      setBillingScrollTarget$,
      opensBuyCredits && resolved === "billing" ? "buy-credits" : null,
    );
    await set(setSettingsDialogOpen$, true, signal);
  },
);
