import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@vm0/ui";
import { IconChevronDown, IconPlus, IconMail } from "@tabler/icons-react";
import { clerk$, currentOrgInfo$ } from "../../signals/auth.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
} from "../../signals/utils.ts";
import { org$ } from "../../signals/org.ts";
import {
  userInvitations$,
  refreshUserInvitations$,
} from "../../signals/user-invitations.ts";
import {
  creatingOrg$,
  setCreatingOrg$,
  acceptingInvitationId$,
  setAcceptingInvitationId$,
} from "../../signals/select-org/org-switcher-ui.ts";

function OrgAvatar({
  name,
  imageUrl,
  size = "sm",
}: {
  name: string;
  imageUrl?: string | null;
  size?: "sm" | "lg";
}) {
  const dim = size === "lg" ? "h-10 w-10" : "h-6 w-6";
  const radius = size === "lg" ? "rounded-xl" : "rounded-md";
  const textSize = size === "lg" ? "text-base" : "text-[11px]";
  const initial = name.charAt(0).toUpperCase();

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className={`${dim} ${radius} object-cover shrink-0`}
      />
    );
  }

  return (
    <div
      className={`${dim} ${radius} bg-[hsl(var(--gray-200))] text-[hsl(var(--primary-700))] flex items-center justify-center ${textSize} font-bold shrink-0`}
    >
      {initial}
    </div>
  );
}

function InvitationRow({
  invitation,
}: {
  invitation: {
    id: string;
    publicOrganizationData: { name: string; imageUrl: string };
    accept: () => Promise<unknown>;
  };
}) {
  const acceptingId = useGet(acceptingInvitationId$);
  const setAcceptingId = useSet(setAcceptingInvitationId$);
  const refreshInvitations = useSet(refreshUserInvitations$);
  const isAccepting = acceptingId === invitation.id;

  const handleAccept = onDomEventFn(async () => {
    setAcceptingId(invitation.id);
    await bestEffort(
      (async () => {
        await invitation.accept();
        refreshInvitations();
      })(),
    );
    setAcceptingId(null);
  });

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <OrgAvatar
        name={invitation.publicOrganizationData.name}
        imageUrl={invitation.publicOrganizationData.imageUrl}
      />
      <span className="min-w-0 flex-1 text-sm truncate">
        {invitation.publicOrganizationData.name}
      </span>
      <button
        type="button"
        disabled={isAccepting}
        onClick={handleAccept}
        className="shrink-0 flex items-center gap-1 px-2 h-7 rounded-md text-xs font-medium text-muted-foreground border border-border hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:pointer-events-none"
      >
        <IconMail size={13} />
        {isAccepting ? "Joining…" : "Join"}
      </button>
    </div>
  );
}

function CreateWorkspaceItem() {
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const creatingOrg = useGet(creatingOrg$);
  const setCreating = useSet(setCreatingOrg$);

  const handleCreateOrg = onDomEventFn(async () => {
    if (!clerk) {
      return;
    }
    setCreating(true);
    const slug = `workspace-${crypto.randomUUID().slice(0, 8)}`;
    await bestEffort(
      (async () => {
        const org = await clerk.createOrganization({ name: slug, slug });
        await clerk.setActive({ organization: org.id });
      })(),
    );
    setCreating(false);
  });

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={handleCreateOrg}
        disabled={clerk === null || creatingOrg}
        className="gap-3 px-3 py-2.5 rounded-lg"
      >
        <IconPlus
          size={18}
          stroke={1.5}
          className="shrink-0 text-muted-foreground"
        />
        <span>{creatingOrg ? "Creating…" : "Create workspace"}</span>
      </DropdownMenuItem>
    </>
  );
}

function OtherMembershipsList() {
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const memberships = clerk?.user?.organizationMemberships ?? [];
  const currentOrgId = clerk?.organization?.id;

  const otherMemberships = memberships.filter((m) => {
    return m.organization && m.organization.id !== currentOrgId;
  });

  if (otherMemberships.length === 0) {
    return null;
  }

  const handleSwitchOrg = (orgId: string) => {
    detach(clerk?.setActive({ organization: orgId }), Reason.DomCallback);
  };

  return (
    <>
      <DropdownMenuSeparator />
      {otherMemberships.map((membership) => {
        return (
          <DropdownMenuItem
            key={membership.organization.id}
            onClick={() => {
              handleSwitchOrg(membership.organization.id);
            }}
            className="gap-3 px-3 py-2.5 rounded-lg"
          >
            <OrgAvatar
              name={membership.organization.name}
              imageUrl={membership.organization.imageUrl}
            />
            <span className="truncate flex-1">
              {membership.organization.name}
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function OrgDropdownContent() {
  const clerkLoadable = useLastLoadable(clerk$);
  const orgData = useLastResolved(org$);
  const pendingInvitations = useLastResolved(userInvitations$);
  const currentOrg = useLastResolved(currentOrgInfo$);

  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const orgName = currentOrg?.name ?? "Organization";
  const orgSlug = orgData?.slug;

  const hasPendingInvitations =
    pendingInvitations !== undefined && pendingInvitations.length > 0;
  const canCreateOrg = clerk?.user?.createOrganizationEnabled ?? false;

  return (
    <DropdownMenuContent align="start" className="w-72">
      <div className="flex items-center gap-3 px-2 py-1.5">
        <OrgAvatar name={orgName} imageUrl={currentOrg?.imageUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight truncate text-foreground">
            {orgName}
          </p>
          {orgSlug && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {orgSlug}
            </p>
          )}
        </div>
      </div>

      <OtherMembershipsList />

      {/* Pending invitations */}
      {hasPendingInvitations && (
        <>
          <DropdownMenuSeparator />
          {pendingInvitations.map((invitation) => {
            return (
              <InvitationRow key={invitation.id} invitation={invitation} />
            );
          })}
        </>
      )}

      {canCreateOrg && <CreateWorkspaceItem />}
    </DropdownMenuContent>
  );
}

function PendingInvitationsBadge() {
  const pendingInvitations = useLastResolved(userInvitations$);
  const hasPendingInvitations =
    pendingInvitations !== undefined && pendingInvitations.length > 0;
  if (!hasPendingInvitations) {
    return null;
  }
  return (
    <span
      data-testid="pending-invitations-badge"
      className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-sidebar"
    />
  );
}

export function ZeroOrgSwitcher() {
  const currentOrg = useLastResolved(currentOrgInfo$);
  const orgName = currentOrg?.name ?? "Organization";

  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
          >
            <span className="relative shrink-0">
              <OrgAvatar name={orgName} imageUrl={currentOrg?.imageUrl} />
              <PendingInvitationsBadge />
            </span>
            <span className="min-w-0 flex-1 text-left text-sm font-semibold leading-tight truncate">
              {orgName}
            </span>
            <IconChevronDown
              size={16}
              className="ml-auto shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <OrgDropdownContent />
      </DropdownMenu>
    </div>
  );
}
