import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef } from "../../utils.ts";
import {
  zeroOrgContract,
  zeroOrgDeleteContract,
  zeroOrgLeaveContract,
} from "@vm0/api-contracts/contracts/zero-org";
import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import type { OrgRole } from "@vm0/api-contracts/contracts/org-members";
import { toast } from "@vm0/ui/components/ui/sonner";
import { org$, refreshOrg$ } from "../../org.ts";
import { zeroClient$ } from "../../api-client.ts";
import { clerk$, resolveAppAuthUrl } from "../../auth.ts";
import { refreshOrgMembers$ } from "../../external/org-members.ts";
import { accept } from "../../../lib/accept.ts";
import { i18n } from "../../../i18n/index.ts";

const internalBillingScrollTarget$ = state<"buy-credits" | null>(null);

export const requestBuyCreditsScroll$ = command(({ set }) => {
  set(internalBillingScrollTarget$, "buy-credits");
});

export const clearBillingScrollTarget$ = command(({ set }) => {
  set(internalBillingScrollTarget$, null);
});

const scrollToBuyCreditsIfRequested$ = command(
  ({ get, set }, element: HTMLDivElement) => {
    if (get(internalBillingScrollTarget$) !== "buy-credits") {
      return;
    }
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    set(clearBillingScrollTarget$);
  },
);

export const buyCreditsScrollRef$ = onRef(
  command(({ get, set }, element: HTMLDivElement, signal: AbortSignal) => {
    if (get(internalBillingScrollTarget$) !== "buy-credits") {
      return;
    }
    animationFrame(
      () => {
        set(scrollToBuyCreditsIfRequested$, element);
      },
      { signal },
    );
  }),
);

// ---------------------------------------------------------------------------
// Workspace profile
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

const internalProfileLogoUrl$ = state<string | null>(null);

export const profileLogoUrl$ = computed((get) => {
  return get(internalProfileLogoUrl$);
});

const internalPendingLogoFile$ = state<File | null>(null);

export const pendingLogoFile$ = computed((get) => {
  return get(internalPendingLogoFile$);
});

const internalPendingLogoPreview$ = state<string | null>(null);

export const pendingLogoPreview$ = computed((get) => {
  return get(internalPendingLogoPreview$);
});

export const setPendingLogo$ = command(
  ({ set }, file: File, signal: AbortSignal) => {
    signal.throwIfAborted();
    const preview = URL.createObjectURL(file);
    signal.addEventListener(
      "abort",
      () => {
        URL.revokeObjectURL(preview);
      },
      { once: true },
    );
    set(internalPendingLogoFile$, file);
    set(internalPendingLogoPreview$, preview);
  },
);

export const clearPendingLogo$ = command(({ set }) => {
  set(internalPendingLogoFile$, null);
  set(internalPendingLogoPreview$, null);
});

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
  async ({ get, set }, signal: AbortSignal) => {
    const org = await get(org$);
    signal.throwIfAborted();
    set(internalProfileName$, org?.name ?? "");
    set(internalProfileSlug$, org?.slug ?? "");
    set(internalProfileLogoUrl$, null);
    set(clearPendingLogo$);
    set(internalLogoLoaded$, false);
  },
);

// ---------------------------------------------------------------------------
// Workspace danger zone
// ---------------------------------------------------------------------------

const internalDeleteConfirm$ = state("");

export const deleteConfirm$ = computed((get) => {
  return get(internalDeleteConfirm$);
});

export const setDeleteConfirm$ = command(({ set }, value: string) => {
  set(internalDeleteConfirm$, value);
});

// ---------------------------------------------------------------------------
// Billing sub-page
// ---------------------------------------------------------------------------

const internalBillingSubPage$ = state(false);

export const billingSubPage$ = computed((get) => {
  return get(internalBillingSubPage$);
});

export const setBillingSubPage$ = command(({ set }, value: boolean) => {
  set(internalBillingSubPage$, value);
});

// ---------------------------------------------------------------------------
// Workspace members
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
// Workspace member invitation
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
// org-billing-tab: DowngradeConfirmDialog selectedTarget
// ---------------------------------------------------------------------------

type BillingCancellationTargetTier = "limited-free-1" | "pro-suspend";
type BillingDowngradeTargetTier = BillingCancellationTargetTier | "pro";

const internalSelectedTarget$ =
  state<BillingDowngradeTargetTier>("limited-free-1");
const internalLockedTarget$ = state<BillingDowngradeTargetTier | null>(null);

export const selectedTarget$ = computed((get) => {
  return get(internalSelectedTarget$);
});

export const lockedTarget$ = computed((get) => {
  return get(internalLockedTarget$);
});

export const setSelectedTarget$ = command(
  ({ set }, value: BillingDowngradeTargetTier) => {
    set(internalSelectedTarget$, value);
  },
);

export const setLockedTarget$ = command(
  ({ set }, value: BillingDowngradeTargetTier | null) => {
    set(internalLockedTarget$, value);
    if (value) {
      set(internalSelectedTarget$, value);
    }
  },
);

// ---------------------------------------------------------------------------
// org-general-tab: async commands
// ---------------------------------------------------------------------------

interface SaveOrgProfileInput {
  readonly name: string;
  readonly slug: string;
  readonly logoFile: File | null;
}

const uploadOrgLogo$ = command(
  async (
    { get },
    file: File,
    signal: AbortSignal,
  ): Promise<{ readonly logoUrl: string | null }> => {
    const formData = new FormData();
    formData.append("file", file);
    const client = get(zeroClient$)(zeroOrgLogoContract);
    const result = await accept(
      client.post({
        body: formData,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const loadOrgLogo$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroOrgLogoContract);
    const result = await accept(
      client.get({
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalProfileLogoUrl$, result.body.logoUrl);
  },
);

export const saveOrgProfile$ = command(
  async (
    { get, set },
    input: SaveOrgProfileInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const org = await get(org$);
    signal.throwIfAborted();
    if (!org) {
      throw new Error("Organization is required to update its profile");
    }

    const hasNameChange = input.name !== (org.name ?? "");
    const hasSlugChange = input.slug !== (org.slug ?? "");

    if (input.logoFile) {
      const result = await set(uploadOrgLogo$, input.logoFile, signal);
      signal.throwIfAborted();
      set(internalProfileLogoUrl$, result.logoUrl);
    }

    if (hasNameChange || hasSlugChange) {
      const body: { name?: string; slug?: string; force?: boolean } = {};
      if (hasNameChange) {
        body.name = input.name;
      }
      if (hasSlugChange) {
        body.slug = input.slug;
        body.force = true;
      }
      const client = get(zeroClient$)(zeroOrgContract);
      await accept(
        client.update({
          body,
          fetchOptions: { signal },
        }),
        [200],
      );
    }

    signal.throwIfAborted();
    set(clearPendingLogo$);
    set(refreshOrg$);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk?.organization?.reload();
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.updated;
      }),
    );
  },
);

export const leaveOrg$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroOrgLeaveContract);
    await accept(
      client.leave({
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk?.setActive({ organization: null });
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.left;
      }),
    );
    window.location.href = resolveAppAuthUrl(
      "/sign-in/tasks/choose-organization",
    );
  },
);

export const deleteOrg$ = command(
  async ({ get }, slug: string, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroOrgDeleteContract);
    await accept(
      client.delete({
        body: { slug },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk?.setActive({ organization: null });
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.deleted;
      }),
    );
    window.location.href = resolveAppAuthUrl(
      "/sign-in/tasks/choose-organization",
    );
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
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.invitationSent;
        },
        { email },
      ),
    );
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
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.roleUpdated;
        },
        { email },
      ),
    );
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
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.roleUpdated;
        },
        { email },
      ),
    );
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
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.memberRemoved;
        },
        { email },
      ),
    );
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
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.invitationRevoked;
      }),
    );
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
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.membershipRequestAccepted;
      }),
    );
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
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.membershipRequestRejected;
      }),
    );
    set(refreshOrgMembers$);
  },
);
