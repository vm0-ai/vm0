// Mock for @clerk/clerk-react
import type { ReactNode } from "react";

interface ClerkProviderProps {
  children: ReactNode;
}

export function ClerkProvider({ children }: ClerkProviderProps) {
  return children;
}

export function OrganizationSwitcher(): string {
  return "OrganizationSwitcher";
}
