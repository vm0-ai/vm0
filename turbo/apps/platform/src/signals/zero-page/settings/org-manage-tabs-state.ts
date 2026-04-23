import { command, computed, state } from "ccstate";
import { onRef } from "../../utils.ts";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/core/contracts/zero-org-members";
import { zeroOrgDomainsContract } from "@vm0/core/contracts/zero-org-domains";
import type {
  OrgEnrollmentMode,
  OrgRole,
} from "@vm0/core/contracts/org-members";
import type { MemberUsage } from "@vm0/core/contracts/zero-usage";
import { toast } from "@vm0/ui/components/ui/sonner";
import { org$, refreshOrg$ } from "../../org.ts";
import { zeroClient$ } from "../../api-client.ts";
import { clerk$ } from "../../auth.ts";
import { refreshOrgMembers$ } from "../../external/org-members.ts";
import { refreshOrgDomains$ } from "../../external/org-domains.ts";
import { setMemberCreditCap$ } from "../member-credit-caps.ts";
import { accept } from "../../../lib/accept.ts";

// ---------------------------------------------------------------------------
// org-manage-dialog: active tab
// ---------------------------------------------------------------------------

export type OrgManageTab =
  | "general"
  | "providers"
  | "members"
  | "domains"
  | "billing"
  | "usage"
  | "invoices";

const internalActiveTab$ = state<OrgManageTab>("general");

export const orgManageTab$ = computed((get) => {
  return get(internalActiveTab$);
});

export const setActiveOrgManageTab$ = command(({ set }, tab: OrgManageTab) => {
  set(internalActiveTab$, tab);
});

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
// org-domains-tab: AddDomainDialog
// ---------------------------------------------------------------------------

const internalAddDomainDialogOpen$ = state(false);

export const addDomainDialogOpen$ = computed((get) => {
  return get(internalAddDomainDialogOpen$);
});

export const setAddDomainDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalAddDomainDialogOpen$, open);
});

const internalAddDomainName$ = state("");

export const addDomainName$ = computed((get) => {
  return get(internalAddDomainName$);
});

export const setAddDomainName$ = command(({ set }, value: string) => {
  set(internalAddDomainName$, value);
});

const internalAddDomainEnrollmentMode$ =
  state<OrgEnrollmentMode>("manual_invitation");

export const addDomainEnrollmentMode$ = computed((get) => {
  return get(internalAddDomainEnrollmentMode$);
});

export const setAddDomainEnrollmentMode$ = command(
  ({ set }, value: OrgEnrollmentMode) => {
    set(internalAddDomainEnrollmentMode$, value);
  },
);

// ---------------------------------------------------------------------------
// org-domains-tab: DomainRow remove dialog (keyed by domain id)
// ---------------------------------------------------------------------------

const internalRemoveDomainDialogTarget$ = state<string | null>(null);

export const removeDomainDialogTarget$ = computed((get) => {
  return get(internalRemoveDomainDialogTarget$);
});

export const setRemoveDomainDialogTarget$ = command(
  ({ set }, target: string | null) => {
    set(internalRemoveDomainDialogTarget$, target);
  },
);

// ---------------------------------------------------------------------------
// org-usage-tab: InlineCapInput values (keyed by userId)
// ---------------------------------------------------------------------------

const internalInlineCapValues$ = state(new Map<string, string>());

export const inlineCapValues$ = computed((get) => {
  return get(internalInlineCapValues$);
});

export const setInlineCapValue$ = command(
  ({ get, set }, userId: string, value: string) => {
    const map = new Map(get(internalInlineCapValues$));
    map.set(userId, value);
    set(internalInlineCapValues$, map);
  },
);

export const discardAllInlineCapValues$ = command(({ set }) => {
  set(internalInlineCapValues$, new Map());
});

export const inlineCapsDirty$ = computed((get) => {
  const capValues = get(internalInlineCapValues$);
  if (capValues.size === 0) {
    return false;
  }
  const members = get(internalUsageMembers$);
  for (const [userId, value] of capValues) {
    const member = members.find((m) => {
      return m.userId === userId;
    });
    const savedValue =
      member?.creditCap !== null && member?.creditCap !== undefined
        ? String(member.creditCap)
        : "";
    if (value !== savedValue) {
      return true;
    }
  }
  return false;
});

// ---------------------------------------------------------------------------
// org-usage-tab: members cache for optimistic cap updates
// ---------------------------------------------------------------------------

const internalUsageMembers$ = state<MemberUsage[]>([]);

export const usageMembers$ = computed((get) => {
  return get(internalUsageMembers$);
});

const internalUsagePrevKey$ = state("");

export const syncUsageMembersFromLoadable$ = command(
  ({ get, set }, rawMembers: MemberUsage[]) => {
    const rawKey = rawMembers
      .map((m) => {
        return `${m.userId}:${m.creditsCharged}`;
      })
      .join(",");
    if (rawKey !== get(internalUsagePrevKey$)) {
      set(internalUsagePrevKey$, rawKey);
      set(
        internalUsageMembers$,
        rawMembers.slice().sort((a, b) => {
          return b.creditsCharged - a.creditsCharged;
        }),
      );
    }
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

const internalSelectedTarget$ = state<"free" | "pro">("free");

export const selectedTarget$ = computed((get) => {
  return get(internalSelectedTarget$);
});

export const setSelectedTarget$ = command(({ set }, value: "free" | "pro") => {
  set(internalSelectedTarget$, value);
});

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

// ---------------------------------------------------------------------------
// org-domains-tab: async commands
// ---------------------------------------------------------------------------

export const addDomain$ = command(
  async (
    { get, set },
    name: string,
    enrollmentMode: OrgEnrollmentMode,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgDomainsContract);
    await accept(
      client.add({
        body: { name, enrollmentMode },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(`Domain ${name} added`);
    set(refreshOrgDomains$);
    set(internalAddDomainDialogOpen$, false);
    set(internalAddDomainName$, "");
    set(internalAddDomainEnrollmentMode$, "manual_invitation");
  },
);

export const removeDomain$ = command(
  async ({ get, set }, domainId: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgDomainsContract);
    await accept(
      client.remove({
        body: { domainId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Domain removed");
    set(refreshOrgDomains$);
    set(internalRemoveDomainDialogTarget$, null);
  },
);

export const setDomainVerified$ = command(
  async (
    { get, set },
    domainId: string,
    verified: boolean,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroOrgDomainsContract);
    await accept(
      client.setVerified({
        body: { domainId, verified },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(verified ? "Domain verified" : "Domain unverified");
    set(refreshOrgDomains$);
  },
);

// ---------------------------------------------------------------------------
// org-usage-tab: batch cap commit
// ---------------------------------------------------------------------------

export const inlineCapBatchCommit$ = command(
  async ({ get, set }, members: MemberUsage[], signal: AbortSignal) => {
    const capValues = get(internalInlineCapValues$);
    const tasks: {
      userId: string;
      creditCap: number | null;
      memberCreditCap: number | null;
    }[] = [];
    for (const [userId, raw] of capValues) {
      const member = members.find((m) => {
        return m.userId === userId;
      });
      if (!member) {
        continue;
      }
      const trimmed = raw.trim();
      const num = trimmed === "" ? 0 : Number(trimmed);
      if (!Number.isInteger(num) || num < 0) {
        continue;
      }
      const cap = num === 0 ? null : num;
      if (cap === member.creditCap) {
        continue;
      }
      tasks.push({ userId, creditCap: cap, memberCreditCap: member.creditCap });
    }
    for (const task of tasks) {
      await set(
        setMemberCreditCap$,
        { userId: task.userId, creditCap: task.creditCap },
        signal,
      );
      set(internalUsageMembers$, (prev) => {
        return prev.map((m) => {
          return m.userId === task.userId
            ? { ...m, creditCap: task.creditCap }
            : m;
        });
      });
    }
    set(internalInlineCapValues$, new Map());
  },
);
