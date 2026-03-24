import { command, computed, state } from "ccstate";
import { org$ } from "../../org.ts";

// ---------------------------------------------------------------------------
// org-manage-dialog: active tab
// ---------------------------------------------------------------------------

export type OrgManageTab =
  | "general"
  | "providers"
  | "members"
  | "billing"
  | "credits"
  | "invoices";

const internalActiveTab$ = state<OrgManageTab>("general");

export const activeTab$ = computed((get) => get(internalActiveTab$));

export const setActiveTab$ = command(({ set }, tab: OrgManageTab) => {
  set(internalActiveTab$, tab);
});

// ---------------------------------------------------------------------------
// org-billing-tab
// ---------------------------------------------------------------------------

const internalIsPro$ = state(false);

export const billingIsPro$ = computed((get) => get(internalIsPro$));

export const setBillingIsPro$ = command(({ set }, value: boolean) => {
  set(internalIsPro$, value);
});

const internalPricingOpen$ = state(false);

export const billingPricingOpen$ = computed((get) => get(internalPricingOpen$));

export const setBillingPricingOpen$ = command(({ set }, value: boolean) => {
  set(internalPricingOpen$, value);
});

// ---------------------------------------------------------------------------
// org-general-tab: ProfileSection
// ---------------------------------------------------------------------------

const internalProfileName$ = state("");

export const profileName$ = computed((get) => get(internalProfileName$));

export const setProfileName$ = command(({ set }, value: string) => {
  set(internalProfileName$, value);
});

const internalProfileSaving$ = state(false);

export const profileSaving$ = computed((get) => get(internalProfileSaving$));

export const setProfileSaving$ = command(({ set }, value: boolean) => {
  set(internalProfileSaving$, value);
});

const internalProfileLogoUrl$ = state<string | null>(null);

export const profileLogoUrl$ = computed((get) => get(internalProfileLogoUrl$));

export const setProfileLogoUrl$ = command(({ set }, value: string | null) => {
  set(internalProfileLogoUrl$, value);
});

const internalPendingLogoFile$ = state<File | null>(null);

export const pendingLogoFile$ = computed((get) =>
  get(internalPendingLogoFile$),
);

export const setPendingLogoFile$ = command(({ set }, value: File | null) => {
  set(internalPendingLogoFile$, value);
});

const internalPendingLogoPreview$ = state<string | null>(null);

export const pendingLogoPreview$ = computed((get) =>
  get(internalPendingLogoPreview$),
);

export const setPendingLogoPreview$ = command(
  ({ set }, value: string | null) => {
    set(internalPendingLogoPreview$, value);
  },
);

const internalFileInputEl$ = state<HTMLInputElement | null>(null);

export const fileInputEl$ = computed((get) => get(internalFileInputEl$));

export const setFileInputEl$ = command(
  ({ set }, value: HTMLInputElement | null) => {
    set(internalFileInputEl$, value);
  },
);

const internalLogoLoaded$ = state(false);

export const logoLoaded$ = computed((get) => get(internalLogoLoaded$));

export const setLogoLoaded$ = command(({ set }, value: boolean) => {
  set(internalLogoLoaded$, value);
});

export const initProfileName$ = command(async ({ get, set }) => {
  const org = await get(org$);
  set(internalProfileName$, org?.name ?? "");
});

// ---------------------------------------------------------------------------
// org-general-tab: DangerZoneSection
// ---------------------------------------------------------------------------

const internalLeaving$ = state(false);

export const leaving$ = computed((get) => get(internalLeaving$));

export const setLeaving$ = command(({ set }, value: boolean) => {
  set(internalLeaving$, value);
});

const internalDeleting$ = state(false);

export const deleting$ = computed((get) => get(internalDeleting$));

export const setDeleting$ = command(({ set }, value: boolean) => {
  set(internalDeleting$, value);
});

const internalDeleteConfirm$ = state("");

export const deleteConfirm$ = computed((get) => get(internalDeleteConfirm$));

export const setDeleteConfirm$ = command(({ set }, value: string) => {
  set(internalDeleteConfirm$, value);
});

// ---------------------------------------------------------------------------
// org-members-tab
// ---------------------------------------------------------------------------

const internalMemberSearch$ = state("");

export const memberSearch$ = computed((get) => get(internalMemberSearch$));

export const setMemberSearch$ = command(({ set }, value: string) => {
  set(internalMemberSearch$, value);
});

const internalInviteEmail$ = state("");

export const inviteEmail$ = computed((get) => get(internalInviteEmail$));

export const setInviteEmail$ = command(({ set }, value: string) => {
  set(internalInviteEmail$, value);
});

const internalInviteTouched$ = state(false);

export const inviteTouched$ = computed((get) => get(internalInviteTouched$));

export const setInviteTouched$ = command(({ set }, value: boolean) => {
  set(internalInviteTouched$, value);
});
