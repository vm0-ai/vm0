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
      appearance={{
        variables: {
          // Primary color matching VM0 design system
          colorPrimary: "#ED4E01", // primary-800
          colorText: "#231F1B", // gray-950
          colorBackground: "#FFFCF9", // gray-0
          colorInputBackground: "#F9F4EF", // gray-50
          colorInputText: "#231F1B", // gray-950
          // Border and radius
          borderRadius: "0.5rem",
          colorDanger: "#EF4444",
          // Font family
          fontFamily:
            "Noto Sans, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        },
        elements: {
          // Card styling
          card: "shadow-lg",
          // Drawer header styling
          drawerHeader: {
            backgroundColor: "#F9F4EF",
            borderBottom: "1px solid #E8E2DD",
          },
          // Form elements
          formButtonPrimary:
            "bg-primary-800 hover:bg-primary-900 text-white font-medium",
          formFieldInput:
            "border-gray-200 focus:border-primary-600 focus:ring-primary-600",
          // Header
          headerTitle: "text-gray-950",
          headerSubtitle: "text-gray-800",
          // Footer
          footerAction: "text-gray-800",
          footerActionLink: "text-primary-800 hover:text-primary-900",
          // Buttons
          socialButtonsBlockButton: "border-gray-200 hover:bg-gray-50",
          socialButtonsBlockButtonText: "text-gray-950 font-medium",
        },
      }}
    >
      {children}
    </BaseClerkProvider>
  );
}
