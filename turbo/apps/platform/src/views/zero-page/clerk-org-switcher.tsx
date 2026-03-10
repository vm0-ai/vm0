import { OrganizationSwitcher } from "@clerk/clerk-react";
import { useEffect, useRef } from "react";
import { useLoadable } from "ccstate-react";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { clerk$ } from "../../signals/auth.ts";

const ORG_ID_KEY = "clerk-active-org-id";

function persistOrgId(orgId: string | undefined) {
  if (orgId) {
    sessionStorage.setItem(ORG_ID_KEY, orgId);
  } else {
    sessionStorage.removeItem(ORG_ID_KEY);
  }
}

function OrgSwitcherInner() {
  const clerkLoadable = useLoadable(clerk$);
  const prevOrgRef = useRef<string | undefined>(
    sessionStorage.getItem(ORG_ID_KEY) ?? undefined,
  );

  useEffect(() => {
    if (clerkLoadable.state !== "hasData") {
      return;
    }
    const clerk = clerkLoadable.data;
    const currentOrgId = clerk.organization?.id ?? undefined;
    prevOrgRef.current = currentOrgId;
    persistOrgId(currentOrgId);

    const unsubscribe = clerk.addListener(() => {
      const newOrgId = clerk.organization?.id ?? undefined;
      if (newOrgId !== prevOrgRef.current) {
        prevOrgRef.current = newOrgId;
        persistOrgId(newOrgId);
        // Full page reload is required because server-side data (agents, jobs,
        // secrets, etc.) is scoped to the active organization. A lighter state
        // refresh is not feasible since multiple signal trees depend on the
        // org context established at bootstrap time.
        location.reload();
      }
    });
    return unsubscribe;
  }, [clerkLoadable]);

  return (
    <OrganizationSwitcher
      appearance={{
        elements: {
          rootBox: "w-full",
          organizationSwitcherTrigger:
            "w-full px-0 py-0 rounded-md hover:bg-sidebar-accent/50 text-sidebar-foreground",
        },
      }}
    />
  );
}

export function ClerkOrgSwitcher() {
  return (
    <VM0ClerkProvider>
      <OrgSwitcherInner />
    </VM0ClerkProvider>
  );
}
