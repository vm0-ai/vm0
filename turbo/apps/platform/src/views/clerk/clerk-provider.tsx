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
      appearance={{
        variables: {
          colorPrimary: "#ED4E01",
          colorText: "#231F1B",
          colorBackground: "#FFFCF9",
          colorInputBackground: "#F9F4EF",
          colorInputText: "#231F1B",
          borderRadius: "0.5rem",
          colorDanger: "#EF4444",
          fontFamily:
            "Noto Sans, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        },
        elements: {
          card: "shadow-lg",
          drawerHeader: {
            backgroundColor: "#F9F4EF",
            borderBottom: "1px solid #E8E2DD",
          },
          formButtonPrimary:
            "bg-primary-800 hover:bg-primary-900 text-white font-medium",
          formFieldInput:
            "border-gray-200 focus:border-primary-600 focus:ring-primary-600",
          headerTitle: "text-gray-950",
          headerSubtitle: "text-gray-800",
          footerAction: "text-gray-800",
          footerActionLink: "text-primary-800 hover:text-primary-900",
          socialButtonsBlockButton: "border-gray-200 hover:bg-gray-50",
          socialButtonsBlockButtonText: "text-gray-950 font-medium",
        },
      }}
    >
      {children}
    </BaseClerkProvider>
  );
}
