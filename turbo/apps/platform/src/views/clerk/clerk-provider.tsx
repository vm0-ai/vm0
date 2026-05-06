import {
  ClerkProvider as BaseClerkProvider,
  type ClerkProviderProps as BaseClerkProviderProps,
} from "@clerk/clerk-react";
import { useLoadable } from "ccstate-react";
import type { ReactNode } from "react";
import { clerk$ } from "../../signals/auth.ts";
import { getClerkAppearance } from "./clerk-appearance.ts";

interface ClerkProviderProps {
  children: ReactNode;
}

export function VM0ClerkProvider({ children }: ClerkProviderProps) {
  const clerkLoadable = useLoadable(clerk$);

  if (clerkLoadable.state !== "hasData") {
    return null;
  }

  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;

  return (
    <BaseClerkProvider
      Clerk={clerkLoadable.data as unknown as BaseClerkProviderProps["Clerk"]}
      publishableKey={publishableKey}
      appearance={getClerkAppearance()}
    >
      {children}
    </BaseClerkProvider>
  );
}
