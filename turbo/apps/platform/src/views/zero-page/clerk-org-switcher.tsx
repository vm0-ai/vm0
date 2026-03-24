import { OrganizationSwitcher } from "@clerk/clerk-react";
import { useGet, useSet } from "ccstate-react";
import { watchOrgSwitch$ } from "../../signals/auth.ts";
import { onRef } from "../../signals/utils.ts";
import {
  orgManageDialogOpen$,
  setOrgManageDialogOpen$,
  patchRef$,
} from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { OrgManageDialog } from "./components/org-manage/org-manage-dialog.tsx";

const orgSwitcherRef$ = onRef(watchOrgSwitch$);

export function ClerkOrgSwitcher() {
  const orgSwitcherRef = useSet(orgSwitcherRef$);
  const patchRef = useSet(patchRef$);
  const dialogOpen = useGet(orgManageDialogOpen$);
  const setDialogOpen = useSet(setOrgManageDialogOpen$);

  return (
    <>
      <div
        ref={(el) => {
          orgSwitcherRef(el);
          patchRef(el);
        }}
      >
        <OrganizationSwitcher
          appearance={{
            elements: {
              rootBox: "!w-full !block",
              organizationSwitcherTrigger:
                "!w-full !px-2 !py-2 !rounded-lg !gap-2.5 hover:bg-sidebar-accent/50 !text-sidebar-foreground",
              organizationPreviewAvatarBox: "!w-7 !h-7 !shrink-0",
              organizationPreviewMainIdentifier:
                "!text-sm !font-semibold !leading-tight !truncate",
              organizationPreviewTextContainer: "!min-w-0 !overflow-hidden",
              notificationBadge:
                "!rounded-full !shrink-0 !aspect-square !min-w-[1.1rem] !h-auto",
              organizationSwitcherTriggerIcon:
                "!w-4 !h-4 !ml-auto !shrink-0 !text-muted-foreground [&_svg]:!stroke-[1.5]",
              organizationSwitcherPopoverCard: "!left-2",
            },
          }}
        />
      </div>
      <OrgManageDialog
        open={dialogOpen}
        onOpenChange={(open) => void setDialogOpen(open)}
      />
    </>
  );
}
