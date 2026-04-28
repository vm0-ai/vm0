import { useLastResolved } from "ccstate-react";
import { IconChevronDown } from "@tabler/icons-react";
import { DropdownMenu, DropdownMenuTrigger } from "@vm0/ui";
import { currentOrgInfo$ } from "../../signals/auth.ts";
import {
  OrgAvatar,
  OrgDropdownContent,
  PendingInvitationsBadge,
} from "./zero-org-switcher.tsx";

/**
 * Compact org-switcher pill rendered in the mobile top bar. Reuses the
 * existing dropdown content (org list, invitations, create workspace) but
 * with a top-bar-friendly trigger sized for small screens.
 */
export function MobileOrgSwitcherPill() {
  const currentOrg = useLastResolved(currentOrgInfo$);
  const orgName = currentOrg?.name ?? "Organization";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch workspace"
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
      </DropdownMenuTrigger>
      <OrgDropdownContent />
    </DropdownMenu>
  );
}
