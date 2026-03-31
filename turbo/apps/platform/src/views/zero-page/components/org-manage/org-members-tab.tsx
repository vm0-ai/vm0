import { useState } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  IconSearch,
  IconShieldCheck,
  IconDots,
  IconPlus,
  IconClock,
  IconCheck,
  IconX,
  IconUserPlus,
} from "@tabler/icons-react";
import {
  cn,
  Input,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroOrgMembersContract,
  zeroOrgInviteContract,
  zeroOrgMembershipRequestsContract,
  type OrgRole,
} from "@vm0/core";
import {
  orgMembers$,
  orgPendingInvitations$,
  orgMembershipRequests$,
  refreshOrgMembers$,
  type OrgMember,
  type OrgPendingInvitation,
  type OrgMembershipRequest,
} from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$, refreshOrg$ } from "../../../../signals/org.ts";
import { user$, clerk$ } from "../../../../signals/auth.ts";
import { zeroClient$ } from "../../../../signals/api-client.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { extractApiErrorMessage } from "./org-api-error.ts";
import {
  memberSearch$,
  setMemberSearch$,
  inviteEmail$,
  setInviteEmail$,
  inviteTouched$,
  setInviteTouched$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const ROW_GRID = "grid grid-cols-[1fr_6rem_5.5rem_2rem] gap-x-4 items-center";

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export function OrgMembersTab() {
  const membersLoadable = useLoadable(orgMembers$);
  const pendingLoadable = useLoadable(orgPendingInvitations$);
  const requestsLoadable = useLoadable(orgMembershipRequests$);
  const userLoadable = useLoadable(user$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const createClient = useGet(zeroClient$);
  const clerkLoadable = useLoadable(clerk$);
  const refreshMembers = useSet(refreshOrgMembers$);
  const refreshOrg = useSet(refreshOrg$);

  const search = useGet(memberSearch$);
  const setSearch = useSet(setMemberSearch$);

  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const pendingInvitations =
    pendingLoadable.state === "hasData" ? pendingLoadable.data : [];
  const membershipRequests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const isLoading = membersLoadable.state === "loading";

  const adminCount = members.filter((m) => {
    return m.role === "admin";
  }).length;

  const filtered = (() => {
    if (!search.trim()) {
      return members;
    }
    const q = search.toLowerCase();
    return members.filter((m) => {
      return (
        m.email.toLowerCase().includes(q) ||
        displayName(m).toLowerCase().includes(q)
      );
    });
  })();

  const filteredPending = (() => {
    if (!search.trim()) {
      return pendingInvitations;
    }
    const q = search.toLowerCase();
    return pendingInvitations.filter((inv) => {
      return inv.email.toLowerCase().includes(q);
    });
  })();

  const handleInvite = async (email: string) => {
    const client = createClient(zeroOrgInviteContract);
    const result = await client.invite({ body: { email } });
    if (result.status === 200) {
      toast.success(`Invitation sent to ${email}`);
      refreshMembers();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to invite"));
  };

  const handleRoleChange = async (email: string, role: OrgRole) => {
    const client = createClient(zeroOrgMembersContract);
    const result = await client.updateRole({ body: { email, role } });
    if (result.status === 200) {
      toast.success(`Updated role for ${email}`);
      // Force JWT refresh so the backend sees the updated role
      if (clerkLoadable.state === "hasData") {
        await clerkLoadable.data.session?.getToken({ skipCache: true });
      }
      refreshMembers();
      refreshOrg();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to update role"));
  };

  const handleRemove = async (email: string) => {
    const client = createClient(zeroOrgMembersContract);
    const result = await client.removeMember({ body: { email } });
    if (result.status === 200) {
      toast.success(`Removed ${email}`);
      refreshMembers();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to remove member"));
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    const client = createClient(zeroOrgInviteContract);
    const result = await client.revoke({ body: { invitationId } });
    if (result.status === 200) {
      toast.success("Invitation revoked");
      refreshMembers();
      return;
    }
    throw new Error(
      extractApiErrorMessage(result, "Failed to revoke invitation"),
    );
  };

  const handleAcceptRequest = async (requestId: string) => {
    const client = createClient(zeroOrgMembershipRequestsContract);
    const result = await client.accept({ body: { requestId } });
    if (result.status === 200) {
      toast.success("Membership request accepted");
      refreshMembers();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to accept request"));
  };

  const handleRejectRequest = async (requestId: string) => {
    const client = createClient(zeroOrgMembershipRequestsContract);
    const result = await client.reject({ body: { requestId } });
    if (result.status === 200) {
      toast.success("Membership request rejected");
      refreshMembers();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to reject request"));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <IconSearch
            size={15}
            stroke={1.5}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            type="text"
            placeholder="Search"
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            className="pl-9"
          />
        </div>
        {isAdmin && <InviteDialog onInvite={handleInvite} />}
      </div>

      <div className="overflow-hidden rounded-xl bg-card zero-border">
        <div
          className={cn(
            ROW_GRID,
            "sticky top-0 z-10 px-5 py-2.5 text-[13px] font-medium text-foreground bg-card",
          )}
        >
          <div>User</div>
          <div>Joined</div>
          <div>Role</div>
          <div />
        </div>
        <div className="h-0 zero-border-t mx-5" />

        {isLoading && (
          <>
            <MemberRowSkeleton />
            <MemberRowSkeleton />
            <MemberRowSkeleton />
          </>
        )}

        {!isLoading &&
          filtered.length === 0 &&
          filteredPending.length === 0 &&
          membershipRequests.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground">
                {search.trim() ? "No members found" : "No members"}
              </span>
            </div>
          )}

        {!isLoading && membershipRequests.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <IconUserPlus size={13} stroke={1.8} />
                Join requests
              </span>
            </div>
            {membershipRequests.map((req, i) => {
              return (
                <div key={req.id}>
                  {i > 0 && <div className="h-0 zero-border-t mx-5" />}
                  <MembershipRequestRow
                    request={req}
                    onAccept={handleAcceptRequest}
                    onReject={handleRejectRequest}
                  />
                </div>
              );
            })}
            <div className="h-0 zero-border-t mx-5" />
          </>
        )}

        {!isLoading &&
          filtered.map((m, i) => {
            return (
              <div key={m.userId}>
                {(i > 0 || membershipRequests.length > 0) && (
                  <div className="h-0 zero-border-t mx-5" />
                )}
                <MemberRow
                  member={m}
                  isCurrentUser={m.userId === currentUserId}
                  isAdmin={isAdmin}
                  isOnlyAdmin={adminCount < 2}
                  onRoleChange={handleRoleChange}
                  onRemove={handleRemove}
                />
              </div>
            );
          })}

        {!isLoading &&
          filteredPending.map((inv, i) => {
            return (
              <div key={inv.id}>
                {(i > 0 ||
                  filtered.length > 0 ||
                  membershipRequests.length > 0) && (
                  <div className="h-0 zero-border-t mx-5" />
                )}
                <PendingInvitationRow
                  invitation={inv}
                  isAdmin={isAdmin}
                  onRevoke={handleRevokeInvitation}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

function InviteDialog({
  onInvite,
}: {
  onInvite: (email: string) => Promise<void>;
}) {
  const email = useGet(inviteEmail$);
  const setEmail = useSet(setInviteEmail$);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const trimmed = email.trim();
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  const touched = useGet(inviteTouched$);
  const setTouched = useSet(setInviteTouched$);

  const handleSend = () => {
    setSending(true);
    detach(
      onInvite(trimmed).then(
        () => {
          setOpen(false);
          setEmail("");
          setSending(false);
        },
        (error: unknown) => {
          setSending(false);
          const message =
            error instanceof Error
              ? error.message
              : "Failed to send invitation";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!sending) {
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 rounded-lg">
          <IconPlus size={14} stroke={2} />
          Add member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Send an invitation to join this workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Input
            placeholder="email@example.com"
            type="email"
            value={email}
            disabled={sending}
            onChange={(e) => {
              setEmail(e.target.value);
              setTouched(false);
            }}
            onBlur={() => {
              return setTouched(true);
            }}
          />
          {touched && trimmed && !isValid && (
            <p className="text-[13px] text-destructive">
              Please enter a valid email address
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setOpen(false);
            }}
            disabled={sending}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!isValid || sending} onClick={handleSend}>
            {sending ? "Sending..." : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  isCurrentUser,
  isAdmin,
  isOnlyAdmin,
  onRoleChange,
  onRemove,
}: {
  member: OrgMember;
  isCurrentUser: boolean;
  isAdmin: boolean;
  isOnlyAdmin: boolean;
  onRoleChange: (email: string, role: OrgRole) => Promise<void>;
  onRemove: (email: string) => Promise<void>;
}) {
  const name = displayName(member);
  const initial = (name || member.email).charAt(0).toUpperCase();
  const canManage = isAdmin && !isCurrentUser;
  const canSelfDemote =
    isAdmin && isCurrentUser && member.role === "admin" && !isOnlyAdmin;

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <MemberAvatar
          imageUrl={member.imageUrl}
          initial={initial}
          name={name || member.email}
        />
        <div className="min-w-0">
          {name && (
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground truncate">
              {name}
              {isCurrentUser && (
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground leading-none">
                  You
                </span>
              )}
            </span>
          )}
          <p className="text-[13px] text-muted-foreground truncate">
            {member.email}
          </p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(member.joinedAt)}
      </div>
      <div>
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconShieldCheck
            size={12}
            stroke={1.8}
            className={
              member.role === "admin"
                ? "text-blue-500"
                : "text-muted-foreground/40"
            }
          />
          {member.role === "admin" ? "Admin" : "Member"}
        </span>
      </div>
      <div className="flex justify-end">
        {canManage && (
          <MemberActions
            member={member}
            onRoleChange={onRoleChange}
            onRemove={onRemove}
          />
        )}
        {canSelfDemote && (
          <SelfDemoteAction email={member.email} onRoleChange={onRoleChange} />
        )}
      </div>
    </div>
  );
}

function SelfDemoteAction({
  email,
  onRoleChange,
}: {
  email: string;
  onRoleChange: (email: string, role: OrgRole) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleConfirm = () => {
    setLoading(true);
    detach(
      onRoleChange(email, "member").then(
        () => {
          setOpen(false);
          setLoading(false);
        },
        (error: unknown) => {
          setLoading(false);
          const message =
            error instanceof Error ? error.message : "Failed to change role";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!loading) {
          setOpen(v);
        }
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors">
            <IconDots size={15} stroke={1.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DialogTrigger asChild>
            <DropdownMenuItem>Switch to member</DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch to member?</DialogTitle>
          <DialogDescription>
            You will become a regular member and lose admin privileges. Another
            admin will need to promote you back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setOpen(false);
            }}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={loading}
            onClick={handleConfirm}
          >
            {loading ? "Switching..." : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberActions({
  member,
  onRoleChange,
  onRemove,
}: {
  member: OrgMember;
  onRoleChange: (email: string, role: OrgRole) => Promise<void>;
  onRemove: (email: string) => Promise<void>;
}) {
  const newRole: OrgRole = member.role === "admin" ? "member" : "admin";
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleRemove = () => {
    setRemoving(true);
    detach(
      onRemove(member.email).then(
        () => {
          setOpen(false);
          setRemoving(false);
        },
        (error: unknown) => {
          setRemoving(false);
          const message =
            error instanceof Error ? error.message : "Failed to remove member";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!removing) {
          setOpen(v);
        }
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors">
            <IconDots size={15} stroke={1.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onClick={() => {
              return detach(
                onRoleChange(member.email, newRole),
                Reason.DomCallback,
              );
            }}
          >
            {newRole === "admin" ? "Make admin" : "Make member"}
          </DropdownMenuItem>
          <DialogTrigger asChild>
            <DropdownMenuItem className="text-destructive focus:text-destructive">
              Remove from org
            </DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove member?</DialogTitle>
          <DialogDescription>
            {member.email} will be removed from this workspace and lose access
            to all resources.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setOpen(false);
            }}
            disabled={removing}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={removing}
            onClick={handleRemove}
          >
            {removing ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingInvitationRow({
  invitation,
  isAdmin,
  onRevoke,
}: {
  invitation: OrgPendingInvitation;
  isAdmin: boolean;
  onRevoke: (invitationId: string) => Promise<void>;
}) {
  const initial = invitation.email.charAt(0).toUpperCase();
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const handleRevoke = () => {
    setRevoking(true);
    detach(
      onRevoke(invitation.id).then(
        () => {
          setOpen(false);
          setRevoking(false);
        },
        (error: unknown) => {
          setRevoking(false);
          const message =
            error instanceof Error
              ? error.message
              : "Failed to revoke invitation";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground border border-dashed border-border">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-foreground truncate">{invitation.email}</p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(invitation.createdAt)}
      </div>
      <div>
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconClock size={12} stroke={1.8} className="text-amber-500" />
          Pending
        </span>
      </div>
      <div className="flex justify-end">
        {isAdmin && (
          <Dialog
            open={open}
            onOpenChange={(v) => {
              if (!revoking) {
                setOpen(v);
              }
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors">
                  <IconDots size={15} stroke={1.5} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DialogTrigger asChild>
                  <DropdownMenuItem className="text-destructive focus:text-destructive">
                    Revoke invitation
                  </DropdownMenuItem>
                </DialogTrigger>
              </DropdownMenuContent>
            </DropdownMenu>

            <DialogContent>
              <DialogHeader>
                <DialogTitle>Revoke invitation?</DialogTitle>
                <DialogDescription>
                  The invitation to {invitation.email} will be cancelled. They
                  will no longer be able to join using this invitation.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    return setOpen(false);
                  }}
                  disabled={revoking}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={revoking}
                  onClick={handleRevoke}
                >
                  {revoking ? "Revoking..." : "Revoke"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}

function MembershipRequestRow({
  request,
  onAccept,
  onReject,
}: {
  request: OrgMembershipRequest;
  onAccept: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
}) {
  const name = [request.firstName, request.lastName].filter(Boolean).join(" ");
  const initial = (name || request.email).charAt(0).toUpperCase();
  const [loading, setLoading] = useState(false);

  const handleAccept = () => {
    setLoading(true);
    detach(
      onAccept(request.id).then(
        () => {
          return setLoading(false);
        },
        (error: unknown) => {
          setLoading(false);
          const message =
            error instanceof Error ? error.message : "Failed to accept request";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  const handleReject = () => {
    setLoading(true);
    detach(
      onReject(request.id).then(
        () => {
          return setLoading(false);
        },
        (error: unknown) => {
          setLoading(false);
          const message =
            error instanceof Error ? error.message : "Failed to reject request";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <MemberAvatar
          imageUrl={request.imageUrl}
          initial={initial}
          name={name || request.email}
        />
        <div className="min-w-0">
          {name && (
            <span className="text-sm font-medium text-foreground truncate block">
              {name}
            </span>
          )}
          <p className="text-[13px] text-muted-foreground truncate">
            {request.email}
          </p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(request.createdAt)}
      </div>
      <div>
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconUserPlus size={12} stroke={1.8} className="text-blue-500" />
          Request
        </span>
      </div>
      <div className="flex justify-end gap-1">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-green-600 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors disabled:opacity-50"
          onClick={handleAccept}
          disabled={loading}
          title="Accept request"
        >
          <IconCheck size={15} stroke={2} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          onClick={handleReject}
          disabled={loading}
          title="Reject request"
        >
          <IconX size={15} stroke={2} />
        </button>
      </div>
    </div>
  );
}

function MemberAvatar({
  imageUrl,
  initial,
  name,
}: {
  imageUrl: string;
  initial: string;
  name: string;
}) {
  if (imageUrl) {
    return (
      <div className="h-8 w-8 shrink-0 rounded-lg overflow-hidden">
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground">
      {initial}
    </div>
  );
}

function MemberRowSkeleton() {
  return (
    <div className={cn(ROW_GRID, "py-3 px-5 animate-pulse")}>
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/50" />
        <div className="flex flex-col gap-1">
          <div className="h-4 w-24 rounded bg-muted/50" />
          <div className="h-3 w-36 rounded bg-muted/30" />
        </div>
      </div>
      <div className="h-4 w-20 rounded bg-muted/30" />
      <div className="h-5 w-14 rounded bg-muted/30" />
      <div />
    </div>
  );
}
