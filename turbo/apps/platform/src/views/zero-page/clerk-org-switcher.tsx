import { OrganizationSwitcher } from "@clerk/clerk-react";
import { useSet } from "ccstate-react";
import { watchOrgSwitch$ } from "../../signals/auth.ts";
import { onRef } from "../../signals/utils.ts";

const orgSwitcherRef$ = onRef(watchOrgSwitch$);

export function ClerkOrgSwitcher() {
  const orgSwitcherRef = useSet(orgSwitcherRef$);

  return (
    <div ref={orgSwitcherRef}>
      <OrganizationSwitcher
        appearance={{
          elements: {
            rootBox: "!w-full !block overflow-hidden",
            organizationSwitcherTrigger:
              "!w-full !px-2 !py-2 !rounded-lg !gap-2.5 hover:bg-sidebar-accent/50 !text-sidebar-foreground !overflow-hidden",
            organizationPreviewAvatarBox: "!w-7 !h-7 !shrink-0",
            organizationPreviewMainIdentifier:
              "!text-sm !font-semibold !leading-tight !truncate",
            organizationPreviewTextContainer: "!min-w-0 !overflow-hidden",
            organizationSwitcherTriggerIcon: "!w-4 !h-4 !ml-auto !shrink-0",
            organizationSwitcherPopoverCard: "!left-2",
          },
        }}
      />
    </div>
  );
}
