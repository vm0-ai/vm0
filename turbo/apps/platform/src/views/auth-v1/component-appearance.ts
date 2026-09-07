import type { SignIn } from "@clerk/react";
import type { ComponentProps } from "react";
import type { BrandName } from "../../signals/branding.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";
import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
  platformVm0LogoDarkImg,
  platformVm0LogoImg,
} from "../../lib/static-assets.ts";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

function authV1LogoImageUrl(
  theme: "light" | "dark",
  brandName: BrandName,
): string {
  if (brandName === "Okou") {
    return theme === "dark"
      ? platformOkouWordmarkLightImg
      : platformOkouWordmarkDarkImg;
  }
  return theme === "dark" ? platformVm0LogoImg : platformVm0LogoDarkImg;
}

/**
 * Sign-in is the first hosted Clerk surface migrated to the supported
 * customization stack: a simple base theme, layout options, semantic tokens,
 * and public appearance element keys. Tailwind utilities win through the
 * provider-level Clerk CSS layer instead of specificity overrides.
 */
export function getAuthV1SignInAppearance(
  theme: "light" | "dark",
  authBrand: AuthBrandContext,
): ClerkAppearance {
  return {
    theme: "simple",
    options: {
      elevation: "raised",
      logoImageUrl: authV1LogoImageUrl(theme, authBrand.brandName),
      logoLinkUrl: authBrand.homeUrl,
      logoPlacement: "inside",
      socialButtonsPlacement: "top",
      socialButtonsVariant: "blockButton",
    },
    elements: {
      rootBox: "mx-auto w-full max-w-[25rem]",
      cardBox:
        "w-full overflow-hidden rounded-[12px] border border-border bg-card shadow-none",
      card: "w-full rounded-none border-0 bg-card px-10 py-8 shadow-none",
      header: "items-center p-0 text-center",
      logoBox: "mb-5 flex h-5 items-center justify-center p-0",
      logoImage: "block h-5 w-auto",
      headerTitle: "text-lg font-medium leading-7 text-foreground",
      headerSubtitle: "mt-1 text-sm leading-5 text-muted-foreground",
      main: "mt-8 gap-6",
      socialButtonsRoot: "m-0",
      socialButtons: "grid grid-cols-1 gap-2 sm:grid-cols-2",
      socialButtonsBlockButton:
        "h-9 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-transparent text-sm font-medium text-foreground shadow-none transition-colors hover:bg-state-hover active:bg-state-pressed",
      socialButtonsBlockButtonText: "text-foreground",
      lastAuthenticationStrategyBadge:
        "rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground shadow-sm",
      dividerRow: "my-6 gap-4",
      dividerLine: "bg-border",
      dividerText: "text-sm text-muted-foreground",
      form: "gap-8",
      formFieldRow: "gap-2",
      formField: "gap-2",
      formFieldLabel: "text-sm font-medium leading-5 text-foreground",
      formFieldInput:
        "h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground shadow-none outline-none transition-colors placeholder:text-sm placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10",
      formFieldInput__password:
        "font-mono tracking-wider placeholder:font-sans placeholder:tracking-normal",
      formFieldInputShowPasswordButton:
        "rounded-md border-0 bg-transparent text-muted-foreground shadow-none transition-colors hover:bg-state-hover hover:text-foreground active:bg-state-pressed",
      formFieldInputShowPasswordIcon: "size-4",
      formButtonPrimary:
        "h-9 w-full rounded-lg bg-primary text-[13px] font-medium text-primary-foreground shadow-none transition-colors hover:bg-primary-hover active:bg-primary-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      formButtonReset:
        "text-brand-text transition-colors hover:text-brand-text-hover active:text-brand-text-hover",
      formFieldErrorText: "text-sm text-destructive",
      formFieldHintText: "text-sm text-muted-foreground",
      formFieldInfoText: "text-sm text-muted-foreground",
      formFieldSuccessText: "text-sm text-foreground",
      alertText: "text-sm text-foreground",
      identityPreview: "rounded-lg border border-border bg-muted/50",
      identityPreviewText: "text-foreground",
      identityPreviewEditButton:
        "rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground active:bg-state-pressed",
      formResendCodeLink:
        "text-brand-text transition-colors hover:text-brand-text-hover active:text-brand-text-hover",
      otpCodeFieldInputs: "gap-2",
      otpCodeFieldInput:
        "h-9 w-9 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input text-center text-base font-medium uppercase text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/10",
      alternativeMethods: "gap-2",
      alternativeMethodsBlockButton:
        "h-9 w-full justify-between rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-background px-3 text-sm text-foreground shadow-none transition-colors hover:bg-state-hover active:bg-state-pressed",
      alternativeMethodsBlockButtonText: "text-foreground",
      backLink:
        "text-brand-text transition-colors hover:text-brand-text-hover active:text-brand-text-hover",
      footer: "bg-card",
      footerAction: "text-sm",
      footerAction__signUp:
        "justify-center border-t border-border px-10 py-4 text-brand-text transition-colors hover:text-brand-text-hover",
      footerActionText: "text-foreground",
      footerActionLink:
        "text-inherit no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      footerAction__usePasskey:
        "flex h-9 w-full items-center justify-center rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-background text-[13px] font-medium text-foreground transition-colors hover:bg-state-hover hover:text-foreground active:bg-state-pressed",
      footerPages: "border-t border-border bg-card",
      footerPagesLink:
        "text-brand-text transition-colors hover:text-brand-text-hover active:text-brand-text-hover",
      passkeyIcon__firstFactor: "size-4",
      formFieldCheckboxInput:
        "size-4 shrink-0 rounded-[3px] border-[1.5px] border-foreground/35 bg-transparent shadow-none accent-primary",
      formFieldCheckboxLabel: "text-sm text-foreground",
    },
  };
}

/**
 * Sign-up still uses the restored v1 presentation while it is migrated in a
 * later slice. Keeping this configuration separate prevents the sign-in
 * experiment from silently restyling the neighboring route.
 */
export function getAuthV1LegacyComponentAppearance(
  theme: "light" | "dark",
  brandName: BrandName,
): ClerkAppearance {
  return {
    options:
      brandName === "Okou"
        ? { logoPlacement: "none" }
        : {
            logoImageUrl:
              theme === "dark" ? platformVm0LogoImg : platformVm0LogoDarkImg,
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
