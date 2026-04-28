import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
  SheetDescription,
} from "@vm0/ui";
import {
  IconChevronDown,
  IconSettings,
  IconPlus,
  IconMail,
} from "@tabler/icons-react";
import { clerk$, currentOrgInfo$, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  mobileWorkspaceDrawerOpen$,
  setMobileWorkspaceDrawerOpen$,
} from "../../signals/zero-page/zero-nav.ts";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
import {
  OrgAvatar,
  PendingInvitationsBadge,
} from "./zero-org-switcher.tsx";

function UserIdentityCard() {
  const userLoadable = useLastLoadable(user$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : null;
  const name = user?.fullName ?? "You";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const imageUrl = user?.imageUrl;
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3 px-1 py-1">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={name}
          className="h-10 w-10 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="h-10 w-10 rounded-full bg-[hsl(var(--gray-200))] text-[hsl(var(--primary-700))] flex items-center justify-center text-base font-bold shrink-0">
          {initial}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p
          data-testid="drawer-user-name"
          className="text-sm font-semibold leading-tight truncate text-foreground"
        >
          {name}
        </p>
        {email && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {email}
          </p>
        )}
      </div>
    </div>
  );
}

function CurrentWorkspaceRow({ onClose }: { onClose: () => void }) {
  const currentOrg = useLastResolved(currentOrgInfo$);
  const orgData = useLastResolved(org$);
  const openManage = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const orgName = currentOrg?.name ?? "Organization";
  const orgSlug = orgData?.slug;

  const handleManage = () => {
    onClose();
    detach(openManage(true, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex items-center gap-3 px-2 py-2 rounded-lg bg-muted/40">
      <OrgAvatar name={orgName} imageUrl={currentOrg?.imageUrl} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-tight truncate text-foreground">
          {orgName}
        </p>
        {orgSlug && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {orgSlug}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={handleManage}
        className="shrink-0 flex items-center gap-1 px-2 h-7 rounded-md text-xs font-medium text-muted-foreground border border-[hsl(var(--gray-400))] hover:text-foreground hover:bg-accent transition-colors"
      >
        <IconSettings size={13} />
        Manage
      </button>
    </div>
  );
}

function OtherWorkspacesList({ onClose }: { onClose: () => void }) {
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
    onClose();
    detach(clerk?.setActive({ organization: orgId }), Reason.DomCallback);
  };

  return (
    <div className="flex flex-col gap-0.5">
      {otherMemberships.map((membership) => {
        return (
          <button
            key={membership.organization.id}
            type="button"
            onClick={() => {
              handleSwitchOrg(membership.organization.id);
            }}
            className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent transition-colors text-left"
          >
            <OrgAvatar
              name={membership.organization.name}
              imageUrl={membership.organization.imageUrl}
            />
            <span className="text-sm truncate flex-1">
              {membership.organization.name}
            </span>
          </button>
        );
      })}
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

  const handleAccept = () => {
    setAcceptingId(invitation.id);
    detach(
      invitation
        .accept()
        .then(() => {
          refreshInvitations();
        })
        .finally(() => {
          setAcceptingId(null);
        }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex items-center gap-3 px-2 py-2">
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

function PendingInvitationsList() {
  const pendingInvitations = useLastResolved(userInvitations$);
  if (pendingInvitations === undefined || pendingInvitations.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {pendingInvitations.map((invitation) => {
        return <InvitationRow key={invitation.id} invitation={invitation} />;
      })}
    </div>
  );
}

function CreateWorkspaceButton({ onClose }: { onClose: () => void }) {
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const creatingOrg = useGet(creatingOrg$);
  const setCreating = useSet(setCreatingOrg$);
  const canCreateOrg = clerk?.user?.createOrganizationEnabled ?? false;

  if (!canCreateOrg) {
    return null;
  }

  const handleCreateOrg = () => {
    if (!clerk) {
      return;
    }
    setCreating(true);
    const slug = `workspace-${crypto.randomUUID().slice(0, 8)}`;
    detach(
      clerk
        .createOrganization({ name: slug, slug })
        .then((org) => {
          onClose();
          return clerk.setActive({ organization: org.id });
        })
        .finally(() => {
          setCreating(false);
        }),
      Reason.DomCallback,
    );
  };

  return (
    <button
      type="button"
      onClick={handleCreateOrg}
      disabled={creatingOrg}
      className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent transition-colors text-left disabled:opacity-50 disabled:pointer-events-none"
    >
      <IconPlus
        size={18}
        stroke={1.5}
        className="shrink-0 text-muted-foreground"
      />
      <span className="text-sm">
        {creatingOrg ? "Creating…" : "Create workspace"}
      </span>
    </button>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

export function MobileWorkspaceDrawer() {
  const currentOrg = useLastResolved(currentOrgInfo$);
  const orgName = currentOrg?.name ?? "Organization";
  const open = useGet(mobileWorkspaceDrawerOpen$);
  const setOpen = useSet(setMobileWorkspaceDrawerOpen$);
  const close = () => {
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open workspace drawer"
          data-testid="mobile-org-switcher"
          className="flex h-8 max-w-[160px] items-center gap-1.5 rounded-lg pl-1 pr-1.5 text-foreground hover:bg-muted/50 transition-colors shrink-0"
        >
          <span className="relative shrink-0">
            <OrgAvatar name={orgName} imageUrl={currentOrg?.imageUrl} />
            <PendingInvitationsBadge />
          </span>
          <span className="min-w-0 truncate text-sm font-semibold">
            {orgName}
          </span>
          <IconChevronDown
            size={14}
            stroke={1.8}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        data-testid="mobile-workspace-drawer"
        className="gap-5 px-4 py-5"
      >
        <SheetTitle className="sr-only">Workspace and identity</SheetTitle>
        <SheetDescription className="sr-only">
          Switch workspaces, manage your account, and create a new workspace.
        </SheetDescription>
        <UserIdentityCard />
        <div className="flex flex-col gap-2">
          <SectionLabel>Workspaces</SectionLabel>
          <CurrentWorkspaceRow onClose={close} />
          <OtherWorkspacesList onClose={close} />
        </div>
        <PendingInvitationsList />
        <div className="mt-auto pt-4 border-t border-border/60">
          <CreateWorkspaceButton onClose={close} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
