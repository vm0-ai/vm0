import {
  ClerkProvider as BaseClerkProvider,
  type ClerkProviderProps as BaseClerkProviderProps,
} from "@clerk/clerk-react";
import { useLoadable } from "ccstate-react";
import type { ReactNode } from "react";
import { clerk$ } from "../../signals/auth.ts";

interface ClerkProviderProps {
  children: ReactNode;
}

export function ClerkProvider({ children }: ClerkProviderProps) {
  const clerkLoadable = useLoadable(clerk$);

  if (clerkLoadable.state !== "hasData") {
    return null;
  }

  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;

  // Type assertion needed due to @clerk/shared version mismatch between
  // @clerk/clerk-js and @clerk/clerk-react packages
  return (
    <BaseClerkProvider
      Clerk={clerkLoadable.data as unknown as BaseClerkProviderProps["Clerk"]}
      publishableKey={publishableKey}
    >
      {children}
    </BaseClerkProvider>
  );
}
