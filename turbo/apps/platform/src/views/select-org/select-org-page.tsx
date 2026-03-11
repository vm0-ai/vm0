import { OrganizationList } from "@clerk/clerk-react";
import { useSet } from "ccstate-react";
import { watchOrgSwitch$ } from "../../signals/auth.ts";
import { onRef } from "../../signals/utils.ts";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";

const orgListRef$ = onRef(watchOrgSwitch$);

export function SelectOrgPage() {
  const orgListRef = useSet(orgListRef$);

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar">
      <div ref={orgListRef} className="flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-sidebar-foreground">
            Select an Organization
          </h1>
          <p className="mt-2 text-sm text-sidebar-foreground/60">
            Choose an organization to continue, or accept a pending invitation.
          </p>
        </div>
        <VM0ClerkProvider>
          <OrganizationList hidePersonal skipInvitationScreen />
        </VM0ClerkProvider>
      </div>
    </div>
  );
}
