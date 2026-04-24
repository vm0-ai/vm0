"use client";

import type { SignIn } from "@clerk/nextjs";
import type { ComponentProps } from "react";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

export function getClerkAppearance(theme: "light" | "dark"): ClerkAppearance {
  return {
    layout: {
      logoImageUrl:
        theme === "dark" ? "/assets/vm0-logo.svg" : "/assets/vm0-logo-dark.svg",
      logoPlacement: "inside",
    },
    variables: {
      colorBackground: "hsl(var(--card))",
      colorForeground: "hsl(var(--card-foreground))",
      colorNeutral: "hsl(var(--foreground))",
      colorPrimary: "hsl(var(--primary))",
      colorPrimaryForeground: "hsl(var(--primary-foreground))",
      colorMuted: "hsl(var(--muted))",
      colorMutedForeground: "hsl(var(--muted-foreground))",
      colorInput: "hsl(var(--input))",
      colorInputForeground: "hsl(var(--foreground))",
      colorDanger: "hsl(var(--destructive))",
      colorRing: "hsl(var(--ring))",
    },
    elements: {
      rootBox: {
        margin: "0 auto",
      },
      card: {
        backgroundColor: "hsl(var(--card))",
        border: "1px solid hsl(var(--border))",
        borderRadius: "0.75rem",
        boxShadow: "none",
      },
      headerTitle: "text-foreground font-medium",
      headerSubtitle: "text-muted-foreground",
      socialButtonsBlockButton:
        "h-9 bg-transparent border border-border rounded-lg text-foreground flex items-center justify-center gap-2",
      socialButtonsBlockButtonText: "text-foreground",
      formButtonPrimary:
        "bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-xs font-medium h-9 rounded-md",
      formFieldInput: "text-foreground rounded-lg transition-colors",
      formFieldLabel: "text-foreground",
      footerActionLink: "text-primary hover:text-primary/90",
      identityPreviewText: "text-foreground",
      identityPreviewEditButton: "text-muted-foreground",
      formFieldInputShowPasswordButton: {
        color: "hsl(var(--muted-foreground))",
        border: "none",
        boxShadow: "none",
        background: "transparent",
      },
      otpCodeFieldInput:
        "h-9 w-9 bg-input border border-border rounded-lg text-center text-base font-medium uppercase text-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10",
      formResendCodeLink: "text-primary",
      footer: "hidden",
      organizationListCreateOrganizationActionButton: "!hidden",
      taskChooseOrganizationCreateOrganizationActionButton: "!hidden",
    },
  };
}
