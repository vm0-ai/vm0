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
  IconSettings,
  IconPlus,
  IconMail,
} from "@tabler/icons-react";
import { clerk$, currentOrgInfo$ } from "../../signals/auth.ts";
import { detach, Reason, withCleanup } from "../../signals/utils.ts";
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

// Mobile drawer rows align to the mobile-more-sheet rhythm:
// - 40px avatar (OrgAvatar size="lg") next to a 16px primary / 14px secondary
//   text pair — keeps the touch target tall enough without inflating density.
// - rounded-xl row, hover:bg-muted/40 active:bg-muted/60 tap feedback.
// - active workspace gets bg-muted (the unified neutral surface used by
//   the bottom-tab active pill, pinned-agent ring, and thread avatar).

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
    <div className="flex items-center gap-3 px-3 py-3 rounded-xl bg-muted">
      <OrgAvatar
        name={orgName}
        imageUrl={currentOrg?.imageUrl}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[16px] font-semibold leading-tight truncate text-foreground">
          {orgName}
        </p>
        {orgSlug && (
          <p className="mt-0.5 text-[14px] text-muted-foreground truncate">
            {orgSlug}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={handleManage}
        className="shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-md text-[13px] font-medium text-muted-foreground border border-border bg-background hover:text-foreground hover:bg-accent transition-colors"
      >
        <IconSettings size={14} stroke={1.8} />
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
    <div className="flex flex-col">
      {otherMemberships.map((membership) => {
        return (
          <button
            key={membership.organization.id}
            type="button"
            onClick={() => {
              handleSwitchOrg(membership.organization.id);
            }}
            className="flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
          >
            <OrgAvatar
              name={membership.organization.name}
              imageUrl={membership.organization.imageUrl}
              size="lg"
            />
            <span className="min-w-0 flex-1 text-[16px] font-medium truncate text-foreground">
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
      withCleanup(
        (async () => {
          await invitation.accept();
          refreshInvitations();
        })(),
        () => {
          setAcceptingId(null);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex items-center gap-3 px-3 py-3 rounded-xl">
      <OrgAvatar
        name={invitation.publicOrganizationData.name}
        imageUrl={invitation.publicOrganizationData.imageUrl}
        size="lg"
      />
      <span className="min-w-0 flex-1 text-[16px] font-medium truncate text-foreground">
        {invitation.publicOrganizationData.name}
      </span>
      <button
        type="button"
        disabled={isAccepting}
        onClick={handleAccept}
        className="shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-md text-[13px] font-medium text-muted-foreground border border-border bg-background hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:pointer-events-none"
      >
        <IconMail size={14} stroke={1.8} />
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
    <div className="flex flex-col">
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
      withCleanup(
        (async () => {
          const org = await clerk.createOrganization({ name: slug, slug });
          onClose();
          await clerk.setActive({ organization: org.id });
        })(),
        () => {
          setCreating(false);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <button
      type="button"
      onClick={handleCreateOrg}
      disabled={creatingOrg}
      className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors hover:bg-muted/40 active:bg-muted/60 disabled:opacity-50 disabled:pointer-events-none"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <IconPlus size={20} stroke={1.8} />
      </span>
      <span className="text-[16px] font-medium text-foreground">
        {creatingOrg ? "Creating…" : "Create workspace"}
      </span>
    </button>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 text-[12px] font-medium text-muted-foreground">
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
          className="flex h-10 max-w-[220px] items-center gap-2 rounded-full pl-1 pr-4 text-foreground bg-card/70 backdrop-blur-xl border border-border/60 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:bg-card hover:shadow-[0_2px_6px_rgb(0_0_0/0.06)] transition-all shrink-0"
        >
          <span className="relative shrink-0">
            <OrgAvatar
              name={orgName}
              imageUrl={currentOrg?.imageUrl}
              size="md"
            />
            <PendingInvitationsBadge />
          </span>
          <span className="min-w-0 truncate text-[14px] font-semibold">
            {orgName}
          </span>
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        data-testid="mobile-workspace-drawer"
        className="gap-4 p-4"
        hideClose
      >
        <SheetTitle className="sr-only">Workspaces</SheetTitle>
        <SheetDescription className="sr-only">
          Switch workspaces or create a new one.
        </SheetDescription>
        <div className="flex flex-col gap-2">
          <SectionLabel>Workspaces</SectionLabel>
          <div className="flex flex-col">
            <CurrentWorkspaceRow onClose={close} />
            <OtherWorkspacesList onClose={close} />
          </div>
        </div>
        <PendingInvitationsList />
        <div className="mt-auto pt-3 border-t border-border/60">
          <CreateWorkspaceButton onClose={close} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
