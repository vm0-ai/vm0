import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  IconSearch,
  IconShieldCheck,
  IconDots,
  IconPlus,
  IconClock,
} from "@tabler/icons-react";
import {
  cn,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroOrgMembersContract,
  zeroOrgInviteContract,
  type OrgRole,
} from "@vm0/core";
import {
  orgMembers$,
  orgPendingInvitations$,
  refreshOrgMembers$,
  type OrgMember,
  type OrgPendingInvitation,
} from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$, refreshOrg$ } from "../../../../signals/org.ts";
import { user$, clerk$ } from "../../../../signals/auth.ts";
import { zeroClient$ } from "../../../../signals/api-client.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  memberSearch$,
  setMemberSearch$,
  inviteEmail$,
  setInviteEmail$,
  inviteTouched$,
  setInviteTouched$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const ROW_GRID = "grid grid-cols-[1fr_8rem_6rem_3rem] gap-x-6 items-center";

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
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const isLoading = membersLoadable.state === "loading";

  const filtered = (() => {
    if (!search.trim()) {
      return members;
    }
    const q = search.toLowerCase();
    return members.filter(
      (m) =>
        m.email.toLowerCase().includes(q) ||
        displayName(m).toLowerCase().includes(q),
    );
  })();

  const filteredPending = (() => {
    if (!search.trim()) {
      return pendingInvitations;
    }
    const q = search.toLowerCase();
    return pendingInvitations.filter((inv) =>
      inv.email.toLowerCase().includes(q),
    );
  })();

  const handleInvite = async (email: string) => {
    const client = createClient(zeroOrgInviteContract);
    const result = await client.invite({ body: { email } });
    if (result.status === 200) {
      toast.success(`Invitation sent to ${email}`);
      refreshMembers();
    } else {
      const msg =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 500
          ? result.body.error.message
          : undefined;
      toast.error(msg ?? `Failed to invite (${result.status})`);
    }
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
    } else {
      const msg =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 500
          ? result.body.error.message
          : undefined;
      toast.error(msg ?? `Failed to update role (${result.status})`);
    }
  };

  const handleRemove = async (email: string) => {
    const client = createClient(zeroOrgMembersContract);
    const result = await client.removeMember({ body: { email } });
    if (result.status === 200) {
      toast.success(`Removed ${email}`);
      refreshMembers();
    } else {
      const msg =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 500
          ? result.body.error.message
          : undefined;
      toast.error(msg ?? `Failed to remove member (${result.status})`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative w-80">
          <IconSearch
            size={15}
            stroke={1.5}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <input
            type="text"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10"
          />
        </div>
        {isAdmin && (
          <InviteDialog
            onInvite={(email) =>
              detach(handleInvite(email), Reason.DomCallback)
            }
          />
        )}
      </div>

      <div
        className="overflow-hidden rounded-[10px] bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div
          className={cn(
            ROW_GRID,
            "sticky top-0 z-10 px-4 py-3 text-sm font-medium text-foreground bg-card",
          )}
        >
          <div className="text-left">User</div>
          <div className="text-left">Joined</div>
          <div className="text-left">Role</div>
          <div />
        </div>
        <div className="h-px bg-border/40 mx-4" />

        {isLoading && (
          <>
            <MemberRowSkeleton />
            <MemberRowSkeleton />
            <MemberRowSkeleton />
          </>
        )}

        {!isLoading &&
          filtered.length === 0 &&
          filteredPending.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground">
                {search.trim() ? "No members found" : "No members"}
              </span>
            </div>
          )}

        {!isLoading &&
          filtered.map((m, i) => (
            <div key={m.userId}>
              {i > 0 && <div className="h-px bg-border/40 mx-4" />}
              <MemberRow
                member={m}
                isCurrentUser={m.userId === currentUserId}
                isAdmin={isAdmin}
                onRoleChange={(email, role) =>
                  detach(handleRoleChange(email, role), Reason.DomCallback)
                }
                onRemove={(email) =>
                  detach(handleRemove(email), Reason.DomCallback)
                }
              />
            </div>
          ))}

        {!isLoading &&
          filteredPending.map((inv, i) => (
            <div key={inv.email}>
              {(i > 0 || filtered.length > 0) && (
                <div className="h-px bg-border/40 mx-4" />
              )}
              <PendingInvitationRow invitation={inv} />
            </div>
          ))}
      </div>
    </div>
  );
}

function InviteDialog({ onInvite }: { onInvite: (email: string) => void }) {
  const email = useGet(inviteEmail$);
  const setEmail = useSet(setInviteEmail$);

  const trimmed = email.trim();
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  const touched = useGet(inviteTouched$);
  const setTouched = useSet(setInviteTouched$);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 rounded-lg">
          <IconPlus size={14} stroke={2} />
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Send an invitation to join this organization.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Input
            placeholder="email@example.com"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setTouched(false);
            }}
            onBlur={() => setTouched(true)}
          />
          {touched && trimmed && !isValid && (
            <p className="text-[13px] text-destructive">
              Please enter a valid email address
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button
              size="sm"
              disabled={!isValid}
              onClick={() => {
                onInvite(trimmed);
                setEmail("");
              }}
            >
              Send invitation
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  isCurrentUser,
  isAdmin,
  onRoleChange,
  onRemove,
}: {
  member: OrgMember;
  isCurrentUser: boolean;
  isAdmin: boolean;
  onRoleChange: (email: string, role: OrgRole) => void;
  onRemove: (email: string) => void;
}) {
  const name = displayName(member);
  const initial = (name || member.email).charAt(0).toUpperCase();
  const canManage = isAdmin && !isCurrentUser;
  const canSelfDemote = isAdmin && isCurrentUser && member.role === "admin";

  return (
    <div className={cn(ROW_GRID, "py-3 px-4")}>
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
      <div className="text-left text-sm text-muted-foreground tabular-nums">
        {formatDate(member.joinedAt)}
      </div>
      <div className="text-left">
        <span
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground"
          style={{
            border: "0.7px solid hsl(var(--gray-400))",
            backgroundColor: "hsl(var(--gray-0))",
          }}
        >
          {member.role === "admin" && (
            <IconShieldCheck size={12} stroke={1.8} className="text-blue-500" />
          )}
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
  onRoleChange: (email: string, role: OrgRole) => void;
}) {
  return (
    <Dialog>
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
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onRoleChange(email, "member")}
            >
              Confirm
            </Button>
          </DialogClose>
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
  onRoleChange: (email: string, role: OrgRole) => void;
  onRemove: (email: string) => void;
}) {
  const newRole: OrgRole = member.role === "admin" ? "member" : "admin";

  return (
    <Dialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors">
            <IconDots size={15} stroke={1.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => onRoleChange(member.email, newRole)}>
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
            {member.email} will be removed from this organization and lose
            access to all resources.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onRemove(member.email)}
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingInvitationRow({
  invitation,
}: {
  invitation: OrgPendingInvitation;
}) {
  const initial = invitation.email.charAt(0).toUpperCase();

  return (
    <div className={cn(ROW_GRID, "py-3 px-4 opacity-60")}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground border border-dashed border-border">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-foreground truncate">{invitation.email}</p>
        </div>
      </div>
      <div className="text-left text-sm text-muted-foreground tabular-nums">
        {formatDate(invitation.createdAt)}
      </div>
      <div className="text-left">
        <span
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-medium text-amber-600"
          style={{
            border: "0.7px solid hsl(var(--gray-400))",
            backgroundColor: "hsl(var(--gray-0))",
          }}
        >
          <IconClock size={12} stroke={1.8} />
          Pending
        </span>
      </div>
      <div />
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
    <div className={cn(ROW_GRID, "py-3 px-4 animate-pulse")}>
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
