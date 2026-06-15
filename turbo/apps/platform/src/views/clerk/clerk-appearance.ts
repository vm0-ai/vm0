import type { ClerkProviderProps } from "@clerk/clerk-react";

type Appearance = NonNullable<ClerkProviderProps["appearance"]>;

// Clerk's element styles accept a string (CSS class) or a nested CSS-in-JS
// object. Resolving the full element map through `Appearance["elements"]`
// causes TS2590 "union type too complex" because `Appearance` is a union of
// all per-component themes (SignIn, UserProfile, UserButton, …). We type the
// helper outputs against this minimal local shape and let the final return
// assemble into `Appearance`.
type ElementStyle = string | Record<string, unknown>;
type Elements = Record<string, ElementStyle>;

/**
 * Clerk appearance for hosted UI surfaces (UserProfile modal, sign-in drawer,
 * org switcher, etc.). All colors resolve via CSS custom properties from the
 * VM0 design system in `@vm0/ui/styles/globals.css`, so the same config
 * automatically tracks light/dark themes via the `data-theme` attribute on
 * `<html>` — no JS-side theme listening needed.
 */
export function getClerkAppearance(): Appearance {
  const elements: Elements = {
    ...cardElements(),
    ...navbarElements(),
    ...profileSectionElements(),
    ...formElements(),
    ...chromeElements(),
    ...signInElements(),
    ...userButtonElements(),
  };
  return {
    variables: clerkVariables(),
    elements,
  };
}

function clerkVariables(): Record<string, string> {
  return {
    colorPrimary: "hsl(var(--primary))",
    colorBackground: "hsl(var(--card))",
    colorNeutral: "hsl(var(--foreground))",
    colorText: "hsl(var(--foreground))",
    colorTextSecondary: "hsl(var(--muted-foreground))",
    colorTextOnPrimaryBackground: "hsl(var(--primary-foreground))",
    colorInputBackground: "hsl(var(--input))",
    colorInputText: "hsl(var(--foreground))",
    colorDanger: "hsl(var(--destructive))",
    colorSuccess: "hsl(142 71% 45%)",
    colorWarning: "hsl(38 92% 50%)",
    colorShimmer: "hsl(var(--muted))",
    fontFamily:
      "var(--font-family-sans, 'Noto Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
    fontSize: "0.875rem",
    borderRadius: "0.5rem",
  };
}

function cardElements(): Elements {
  return {
    rootBox: {
      fontFamily: "var(--font-family-sans)",
      color: "hsl(var(--foreground))",
    },
    cardBox: {
      backgroundColor: "hsl(var(--card))",
      border: "0.7px solid hsl(var(--border))",
      borderRadius: "1rem",
      boxShadow:
        "0 2px 12px hsl(220 12% 50% / 0.08), 0 0 0 0.5px hsl(220 12% 50% / 0.04)",
    },
    card: {
      backgroundColor: "hsl(var(--card))",
      boxShadow: "none",
      border: "none",
    },
    headerTitle: {
      color: "hsl(var(--foreground))",
      fontWeight: 600,
    },
    headerSubtitle: {
      color: "hsl(var(--muted-foreground))",
    },
  };
}

function navbarElements(): Elements {
  return {
    navbar: {
      backgroundColor: "hsl(var(--sidebar))",
      borderRight: "0.7px solid hsl(var(--border))",
    },
    navbarMobileMenuRow: {
      backgroundColor: "hsl(var(--sidebar))",
      borderBottom: "0.7px solid hsl(var(--border))",
    },
    navbarMobileMenuButton: {
      color: "hsl(var(--foreground))",
    },
    navbarButton: {
      color: "hsl(var(--muted-foreground))",
      borderRadius: "0.5rem",
      "&:hover": {
        backgroundColor: "hsl(var(--accent))",
        color: "hsl(var(--foreground))",
      },
      '&[data-active="true"], &[aria-selected="true"]': {
        color: "hsl(var(--primary))",
        backgroundColor: "hsl(var(--accent))",
      },
    },
    navbarButtonIcon: {
      color: "currentColor",
    },
  };
}

function profileSectionElements(): Elements {
  return {
    pageScrollBox: { backgroundColor: "hsl(var(--card))" },
    page: { backgroundColor: "hsl(var(--card))" },
    profileSection: {
      borderBottom: "0.7px solid hsl(var(--border))",
    },
    profileSectionTitleText: {
      color: "hsl(var(--foreground))",
      fontWeight: 500,
    },
    profileSectionContent: { color: "hsl(var(--foreground))" },
    profileSectionPrimaryButton: {
      color: "hsl(var(--primary))",
      borderRadius: "0.375rem",
      "&:hover": {
        color: "hsl(var(--primary))",
        backgroundColor: "hsl(var(--accent))",
      },
    },
    profileSectionItem: { color: "hsl(var(--foreground))" },
    accordionTriggerButton: {
      color: "hsl(var(--foreground))",
      borderRadius: "0.375rem",
      "&:hover": { backgroundColor: "hsl(var(--accent))" },
    },
    accordionContent: { color: "hsl(var(--foreground))" },
  };
}

function formElements(): Elements {
  return {
    formButtonPrimary: {
      backgroundColor: "hsl(var(--primary))",
      color: "hsl(var(--primary-foreground))",
      borderRadius: "0.5rem",
      fontWeight: 500,
      textTransform: "none",
      boxShadow: "none",
      transition: "background-color 0.15s",
      "&:hover": { backgroundColor: "hsl(var(--primary) / 0.9)" },
      "&:focus": {
        backgroundColor: "hsl(var(--primary))",
        boxShadow: "0 0 0 3px hsl(var(--primary) / 0.2)",
      },
    },
    formButtonReset: {
      color: "hsl(var(--muted-foreground))",
      "&:hover": {
        color: "hsl(var(--foreground))",
        backgroundColor: "hsl(var(--accent))",
      },
    },
    formFieldInput: {
      backgroundColor: "hsl(var(--input))",
      borderColor: "hsl(var(--border))",
      color: "hsl(var(--foreground))",
      borderRadius: "0.5rem",
      "&:focus": {
        borderColor: "hsl(var(--primary))",
        boxShadow: "0 0 0 3px hsl(var(--primary) / 0.1)",
      },
      "&::placeholder": { color: "hsl(var(--muted-foreground))" },
    },
    formFieldLabel: { color: "hsl(var(--foreground))" },
    formFieldErrorText: { color: "hsl(var(--destructive))" },
    formFieldHintText: { color: "hsl(var(--muted-foreground))" },
    formFieldSuccessText: { color: "hsl(var(--foreground))" },
    formFieldInputShowPasswordButton: {
      color: "hsl(var(--muted-foreground))",
      background: "transparent",
      boxShadow: "none",
      border: "none",
    },
    formResendCodeLink: { color: "hsl(var(--primary))" },
    otpCodeFieldInput: {
      backgroundColor: "hsl(var(--input))",
      borderColor: "hsl(var(--border))",
      color: "hsl(var(--foreground))",
      borderRadius: "0.5rem",
      "&:focus": {
        borderColor: "hsl(var(--primary))",
        boxShadow: "0 0 0 3px hsl(var(--primary) / 0.1)",
      },
    },
  };
}

function chromeElements(): Elements {
  return {
    badge: {
      backgroundColor: "hsl(var(--accent))",
      color: "hsl(var(--accent-foreground))",
      borderRadius: "0.375rem",
      fontWeight: 500,
    },
    menuButton: {
      color: "hsl(var(--muted-foreground))",
      borderRadius: "0.375rem",
      "&:hover": {
        backgroundColor: "hsl(var(--accent))",
        color: "hsl(var(--foreground))",
      },
    },
    menuList: {
      backgroundColor: "hsl(var(--popover))",
      border: "0.7px solid hsl(var(--border))",
      borderRadius: "0.5rem",
      boxShadow: "0 8px 24px hsl(220 12% 20% / 0.12)",
    },
    menuItem: {
      color: "hsl(var(--foreground))",
      borderRadius: "0.375rem",
      "&:hover": { backgroundColor: "hsl(var(--accent))" },
    },
    avatarBox: { borderRadius: "0.5rem" },
    modalBackdrop: {
      backgroundColor: "hsl(220 12% 5% / 0.55)",
      backdropFilter: "blur(2px)",
    },
    modalContent: { backgroundColor: "transparent" },
    modalCloseButton: {
      color: "hsl(var(--muted-foreground))",
      borderRadius: "0.375rem",
      "&:hover": {
        color: "hsl(var(--foreground))",
        backgroundColor: "hsl(var(--accent))",
      },
    },
    dividerLine: { backgroundColor: "hsl(var(--border))" },
    dividerText: { color: "hsl(var(--muted-foreground))" },
  };
}

function signInElements(): Elements {
  return {
    socialButtonsBlockButton: {
      backgroundColor: "transparent",
      borderColor: "hsl(var(--border))",
      color: "hsl(var(--foreground))",
      borderRadius: "0.5rem",
      "&:hover": {
        backgroundColor: "hsl(var(--accent))",
        borderColor: "hsl(var(--border))",
      },
    },
    socialButtonsBlockButtonText: {
      color: "hsl(var(--foreground))",
      fontWeight: 500,
    },
    footer: {
      backgroundColor: "hsl(var(--card))",
      borderTop: "0.7px solid hsl(var(--border))",
    },
    footerAction: { color: "hsl(var(--muted-foreground))" },
    footerActionLink: {
      color: "hsl(var(--primary))",
      "&:hover": { color: "hsl(var(--primary))", opacity: 0.85 },
    },
    identityPreview: {
      backgroundColor: "hsl(var(--accent))",
      borderColor: "hsl(var(--border))",
    },
    identityPreviewText: { color: "hsl(var(--foreground))" },
    identityPreviewEditButton: { color: "hsl(var(--muted-foreground))" },
  };
}

function userButtonElements(): Elements {
  return {
    userButtonPopoverCard: {
      backgroundColor: "hsl(var(--popover))",
      border: "0.7px solid hsl(var(--border))",
      borderRadius: "0.75rem",
      boxShadow: "0 8px 24px hsl(220 12% 20% / 0.12)",
    },
    userButtonPopoverActionButton: {
      color: "hsl(var(--foreground))",
      "&:hover": { backgroundColor: "hsl(var(--accent))" },
    },
    userButtonPopoverFooter: {
      backgroundColor: "hsl(var(--popover))",
      borderTop: "0.7px solid hsl(var(--border))",
    },
    drawerHeader: {
      backgroundColor: "hsl(var(--sidebar))",
      borderBottom: "0.7px solid hsl(var(--border))",
      color: "hsl(var(--foreground))",
    },
    organizationListCreateOrganizationActionButton: { display: "none" },
    taskChooseOrganizationCreateOrganizationActionButton: { display: "none" },
  };
}
