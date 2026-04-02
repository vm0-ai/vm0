import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@vm0/ui";
import { IconChevronDown, IconSettings, IconPlus } from "@tabler/icons-react";
import { clerk$, watchOrgSwitch$ } from "../../signals/auth.ts";
import { detach, onRef, Reason } from "../../signals/utils.ts";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { org$ } from "../../signals/org.ts";

const orgSwitcherRef$ = onRef(watchOrgSwitch$);

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

export function ZeroOrgSwitcher() {
  const orgSwitcherRef = useSet(orgSwitcherRef$);
  const openManage = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const clerkLoadable = useLoadable(clerk$);
  const orgData = useLastResolved(org$);

  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const memberships = clerk?.user?.organizationMemberships ?? [];
  const currentOrgId = clerk?.organization?.id;
  const currentOrg = clerk?.organization;
  const orgName = currentOrg?.name ?? "Organization";
  const orgSlug = orgData?.slug;

  const otherMemberships = memberships.filter((m) => {
    return m.organization && m.organization.id !== currentOrgId;
  });

  const handleSwitchOrg = (orgId: string) => {
    detach(clerk?.setActive({ organization: orgId }), Reason.DomCallback);
  };

  const handleManage = () => {
    detach(openManage(true, pageSignal), Reason.DomCallback);
  };

  const handleCreateOrg = () => {
    if (!clerk) {
      return;
    }
    const slug = `workspace-${crypto.randomUUID().slice(0, 8)}`;
    detach(
      clerk.createOrganization({ name: slug, slug }).then((org) => {
        return clerk.setActive({ organization: org.id });
      }),
      Reason.DomCallback,
    );
  };

  const isClerkReady = clerk !== null;

  return (
    <div ref={orgSwitcherRef}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-sidebar-accent/50 text-sidebar-foreground transition-colors"
          >
            <OrgAvatar name={orgName} imageUrl={currentOrg?.imageUrl} />
            <span className="min-w-0 flex-1 text-left text-sm font-semibold leading-tight truncate">
              {orgName}
            </span>
            <IconChevronDown
              size={16}
              className="ml-auto shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {/* Header: current org info + manage button */}
          <div className="flex items-center gap-3 px-2 py-1.5">
            <OrgAvatar
              name={orgName}
              imageUrl={currentOrg?.imageUrl}
              size="lg"
            />
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
            <button
              type="button"
              onClick={handleManage}
              className="shrink-0 flex items-center gap-1 px-2 h-7 rounded-md text-xs font-medium text-muted-foreground border border-border hover:text-foreground hover:bg-accent transition-colors"
            >
              <IconSettings size={13} />
              Manage
            </button>
          </div>

          {/* Switch to other orgs */}
          {otherMemberships.length > 0 && (
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
          )}

          {/* Create workspace */}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleCreateOrg}
            disabled={!isClerkReady}
            className="gap-3 px-3 py-2.5 rounded-lg"
          >
            <IconPlus
              size={18}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            <span>Create workspace</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
