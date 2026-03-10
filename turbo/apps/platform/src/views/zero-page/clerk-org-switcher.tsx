import { OrganizationSwitcher } from "@clerk/clerk-react";
import { useSet } from "ccstate-react";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { watchOrgSwitch$ } from "../../signals/auth.ts";
import { onRef } from "../../signals/utils.ts";

const orgSwitcherRef$ = onRef(watchOrgSwitch$);

function OrgSwitcherInner() {
  const orgSwitcherRef = useSet(orgSwitcherRef$);

  return (
    <div ref={orgSwitcherRef}>
      <OrganizationSwitcher
        appearance={{
          elements: {
            rootBox: "w-full",
            organizationSwitcherTrigger:
              "w-full px-0 py-0 rounded-md hover:bg-sidebar-accent/50 text-sidebar-foreground",
          },
        }}
      />
    </div>
  );
}

export function ClerkOrgSwitcher() {
  return (
    <VM0ClerkProvider>
      <OrgSwitcherInner />
    </VM0ClerkProvider>
  );
}
