import { command, computed, state } from "ccstate";
import { onRef } from "../../utils.ts";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import type { OrgRole } from "@vm0/api-contracts/contracts/org-members";
import { toast } from "@vm0/ui/components/ui/sonner";
import { org$, refreshOrg$ } from "../../org.ts";
import { zeroClient$ } from "../../api-client.ts";
import { clerk$ } from "../../auth.ts";
import { refreshOrgMembers$ } from "../../external/org-members.ts";
import { accept } from "../../../lib/accept.ts";

// ---------------------------------------------------------------------------
// org-manage-dialog: active tab
// ---------------------------------------------------------------------------

export type OrgManageTab =
  | "general"
  | "providers"
  | "members"
  | "billing"
  | "usage"
  | "invoices";

const internalActiveTab$ = state<OrgManageTab>("general");
const internalBillingScrollTarget$ = state<"buy-credits" | null>(null);

export const orgManageTab$ = computed((get) => {
  return get(internalActiveTab$);
});

export const billingScrollTarget$ = computed((get) => {
  return get(internalBillingScrollTarget$);
});

export const setActiveOrgManageTab$ = command(({ set }, tab: OrgManageTab) => {
  set(internalActiveTab$, tab);
});

export const setBillingScrollTarget$ = command(
  ({ set }, target: "buy-credits" | null) => {
    set(internalBillingScrollTarget$, target);
  },
);

// ---------------------------------------------------------------------------
// org-general-tab: ProfileSection
// ---------------------------------------------------------------------------

const internalProfileName$ = state("");

export const profileName$ = computed((get) => {
  return get(internalProfileName$);
});

export const setProfileName$ = command(({ set }, value: string) => {
  set(internalProfileName$, value);
});

const internalProfileSlug$ = state("");

export const profileSlug$ = computed((get) => {
  return get(internalProfileSlug$);
});

export const setProfileSlug$ = command(({ set }, value: string) => {
  set(internalProfileSlug$, value);
});

const internalProfileSaving$ = state(false);

export const profileSaving$ = computed((get) => {
  return get(internalProfileSaving$);
});

export const setProfileSaving$ = command(({ set }, value: boolean) => {
  set(internalProfileSaving$, value);
});

const internalProfileLogoUrl$ = state<string | null>(null);

export const profileLogoUrl$ = computed((get) => {
  return get(internalProfileLogoUrl$);
});

export const setProfileLogoUrl$ = command(({ set }, value: string | null) => {
  set(internalProfileLogoUrl$, value);
});

const internalPendingLogoFile$ = state<File | null>(null);

export const pendingLogoFile$ = computed((get) => {
  return get(internalPendingLogoFile$);
});

export const setPendingLogoFile$ = command(({ set }, value: File | null) => {
  set(internalPendingLogoFile$, value);
});

const internalPendingLogoPreview$ = state<string | null>(null);

export const pendingLogoPreview$ = computed((get) => {
  return get(internalPendingLogoPreview$);
});

export const setPendingLogoPreview$ = command(
  ({ set }, value: string | null) => {
    set(internalPendingLogoPreview$, value);
  },
);

const internalFileInputEl$ = state<HTMLInputElement | null>(null);

export const fileInputEl$ = computed((get) => {
  return get(internalFileInputEl$);
});

export const setFileInputEl$ = onRef(
  command(({ set }, el: HTMLInputElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalFileInputEl$, null);
    });
    set(internalFileInputEl$, el);
  }),
);

const internalLogoLoaded$ = state(false);

export const logoLoaded$ = computed((get) => {
  return get(internalLogoLoaded$);
});

export const setLogoLoaded$ = command(({ set }, value: boolean) => {
  set(internalLogoLoaded$, value);
});

export const initProfileName$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const org = await get(org$);
    set(internalProfileName$, org?.name ?? "");
    set(internalProfileSlug$, org?.slug ?? "");
  },
);

// ---------------------------------------------------------------------------
// org-general-tab: DangerZoneSection
// ---------------------------------------------------------------------------

const internalLeaving$ = state(false);

export const leaving$ = computed((get) => {
  return get(internalLeaving$);
});

export const setLeaving$ = command(({ set }, value: boolean) => {
  set(internalLeaving$, value);
});

const internalDeleting$ = state(false);

export const deleting$ = computed((get) => {
  return get(internalDeleting$);
});

export const setDeleting$ = command(({ set }, value: boolean) => {
  set(internalDeleting$, value);
});

const internalDeleteConfirm$ = state("");

export const deleteConfirm$ = computed((get) => {
  return get(internalDeleteConfirm$);
});

export const setDeleteConfirm$ = command(({ set }, value: string) => {
  set(internalDeleteConfirm$, value);
});

// ---------------------------------------------------------------------------
// org-billing-tab: sub-page
// ---------------------------------------------------------------------------

const internalBillingSubPage$ = state(false);

export const billingSubPage$ = computed((get) => {
  return get(internalBillingSubPage$);
});

export const setBillingSubPage$ = command(({ set }, value: boolean) => {
  set(internalBillingSubPage$, value);
});

export const openBillingPlans$ = command(({ set }) => {
  set(internalActiveTab$, "billing");
  set(internalBillingSubPage$, true);
});

// ---------------------------------------------------------------------------
// org-members-tab
// ---------------------------------------------------------------------------

const internalMemberSearch$ = state("");

export const memberSearch$ = computed((get) => {
  return get(internalMemberSearch$);
});

export const setMemberSearch$ = command(({ set }, value: string) => {
  set(internalMemberSearch$, value);
});

const internalInviteEmail$ = state("");

export const inviteEmail$ = computed((get) => {
  return get(internalInviteEmail$);
});

export const setInviteEmail$ = command(({ set }, value: string) => {
  set(internalInviteEmail$, value);
});

const internalInviteTouched$ = state(false);

export const inviteTouched$ = computed((get) => {
  return get(internalInviteTouched$);
});

export const setInviteTouched$ = command(({ set }, value: boolean) => {
  set(internalInviteTouched$, value);
});

// ---------------------------------------------------------------------------
// org-members-tab: InviteDialog
// ---------------------------------------------------------------------------

const internalInviteDialogOpen$ = state(false);

export const inviteDialogOpen$ = computed((get) => {
  return get(internalInviteDialogOpen$);
});

export const setInviteDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalInviteDialogOpen$, open);
});

const internalInviteRole$ = state<OrgRole>("member");

export const inviteRole$ = computed((get) => {
  return get(internalInviteRole$);
});

export const setInviteRole$ = command(({ set }, value: OrgRole) => {
  set(internalInviteRole$, value);
});

// ---------------------------------------------------------------------------
// org-members-tab: SelfDemoteAction dialog
// ---------------------------------------------------------------------------

const internalSelfDemoteDialogOpen$ = state(false);

export const selfDemoteDialogOpen$ = computed((get) => {
  return get(internalSelfDemoteDialogOpen$);
});

export const setSelfDemoteDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalSelfDemoteDialogOpen$, open);
});

// ---------------------------------------------------------------------------
// org-members-tab: MemberActions remove dialog (keyed by email)
// ---------------------------------------------------------------------------

const internalRemoveMemberDialogTarget$ = state<string | null>(null);

export const removeMemberDialogTarget$ = computed((get) => {
  return get(internalRemoveMemberDialogTarget$);
});

export const setRemoveMemberDialogTarget$ = command(
  ({ set }, target: string | null) => {
    set(internalRemoveMemberDialogTarget$, target);
  },
);

// ---------------------------------------------------------------------------
// org-members-tab: PendingInvitationRow revoke dialog (keyed by id)
// ---------------------------------------------------------------------------

const internalRevokeInvitationDialogTarget$ = state<string | null>(null);

export const revokeInvitationDialogTarget$ = computed((get) => {
  return get(internalRevokeInvitationDialogTarget$);
});

export const setRevokeInvitationDialogTarget$ = command(
  ({ set }, target: string | null) => {
    set(internalRevokeInvitationDialogTarget$, target);
  },
);

// ---------------------------------------------------------------------------
// org-general-tab: ProfileSection saveError
// ---------------------------------------------------------------------------

const internalSaveError$ = state<string | null>(null);

export const saveError$ = computed((get) => {
  return get(internalSaveError$);
});

export const setSaveError$ = command(({ set }, value: string | null) => {
  set(internalSaveError$, value);
});

// ---------------------------------------------------------------------------
// org-billing-tab: DowngradeConfirmDialog selectedTarget
// ---------------------------------------------------------------------------

const internalSelectedTarget$ = state<"pro-suspend" | "pro">("pro-suspend");

export const selectedTarget$ = computed((get) => {
  return get(internalSelectedTarget$);
});

export const setSelectedTarget$ = command(
  ({ set }, value: "pro-suspend" | "pro") => {
    set(internalSelectedTarget$, value);
  },
);

// ---------------------------------------------------------------------------
// org-members-tab: async commands
// ---------------------------------------------------------------------------

export const inviteMember$ = command(
  async ({ get, set }, email: string, role: OrgRole, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgInviteContract);
    await accept(
      client.invite({
        body: { email, role },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(`Invitation sent to ${email}`);
    set(refreshOrgMembers$);
    set(internalInviteDialogOpen$, false);
    set(internalInviteEmail$, "");
    set(internalInviteRole$, "member");
  },
);

export const changeRole$ = command(
  async ({ get, set }, email: string, role: OrgRole, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgMembersContract);
    await accept(
      client.updateRole({
        body: { email, role },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(`Updated role for ${email}`);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk.session?.getToken({ skipCache: true });
    signal.throwIfAborted();
    set(refreshOrgMembers$);
    set(refreshOrg$);
  },
);

export const selfDemote$ = command(
  async ({ get, set }, email: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgMembersContract);
    await accept(
      client.updateRole({
        body: { email, role: "member" },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(`Updated role for ${email}`);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk.session?.getToken({ skipCache: true });
    signal.throwIfAborted();
    set(refreshOrgMembers$);
    set(refreshOrg$);
    set(internalSelfDemoteDialogOpen$, false);
  },
);

export const removeMember$ = command(
  async ({ get, set }, email: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgMembersContract);
    await accept(
      client.removeMember({
        body: { email },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(`Removed ${email}`);
    set(refreshOrgMembers$);
    set(internalRemoveMemberDialogTarget$, null);
  },
);

export const revokeInvitation$ = command(
  async ({ get, set }, invitationId: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgInviteContract);
    await accept(
      client.revoke({
        body: { invitationId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Invitation revoked");
    set(refreshOrgMembers$);
    set(internalRevokeInvitationDialogTarget$, null);
  },
);

export const acceptRequest$ = command(
  async ({ get, set }, requestId: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgMembershipRequestsContract);
    await accept(
      client.accept({
        body: { requestId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Membership request accepted");
    set(refreshOrgMembers$);
  },
);

export const rejectRequest$ = command(
  async ({ get, set }, requestId: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgMembershipRequestsContract);
    await accept(
      client.reject({
        body: { requestId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Membership request rejected");
    set(refreshOrgMembers$);
  },
);
