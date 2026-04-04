// Mock for @clerk/clerk-react
import { createElement, type ReactNode } from "react";

interface ClerkProviderProps {
  children: ReactNode;
}

export function ClerkProvider({ children }: ClerkProviderProps) {
  return children;
}

export function OrganizationSwitcher(): string {
  return "OrganizationSwitcher";
}

interface OrgListProps {
  hidePersonal?: boolean;
  skipInvitationScreen?: boolean;
}

export function OrganizationList({
  hidePersonal,
  skipInvitationScreen,
}: OrgListProps) {
  return createElement("div", {
    "data-testid": "organization-list",
    "data-hide-personal": String(!!hidePersonal),
    "data-skip-invitation-screen": String(!!skipInvitationScreen),
  });
}
