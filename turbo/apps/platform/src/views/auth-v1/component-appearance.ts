import { buttonVariants, cardClassName, cn, inputClassName } from "@okouai/ui";
import type { SignIn } from "@clerk/react";
import type { ComponentProps } from "react";

import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
  platformVm0LogoDarkImg,
  platformVm0LogoImg,
} from "../../lib/static-assets.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";
import type { BrandName } from "../../signals/branding.ts";
import { AUTH_LINK_ACTION_CLASS } from "../auth/auth-action-styles.ts";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

const authV1OutlineActionClass = cn(
  buttonVariants({ size: "default", variant: "outline" }),
  "w-full shadow-none",
);
const authV1SocialActionClass = cn(authV1OutlineActionClass, "bg-transparent");
const authV1PrimaryActionClass = cn(
  buttonVariants({ size: "default", variant: "default" }),
  "w-full okou-auth-action-text shadow-none",
);
const authV1OtpInputClass = cn(
  inputClassName,
  "w-9 px-0 text-center text-base font-medium uppercase",
);
const authV1PasswordToggleClass = cn(
  buttonVariants({ size: "icon", variant: "ghost" }),
  "text-foreground",
);
const authV1IdentityPreviewEditClass = buttonVariants({
  size: "icon-2xs",
  variant: "quiet",
});

// Clerk always adds `crossorigin="anonymous"` to its logo image. Okou's
// public static host explicitly allows app.okou.ai. Retain the VM0 fallback
// until that dormant hosted surface is intentionally migrated.
function transparentClerkLogoImageUrl(brandName: BrandName): string {
  const { width, height } =
    brandName === "Okou"
      ? { width: 1934, height: 512 }
      : { width: 100, height: 30 };
  return `data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27${width}%27 height=%27${height}%27 viewBox=%270 0 ${width} ${height}%27%3E%3C/svg%3E`;
}

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
  const logoImageUrl = authV1LogoImageUrl(theme, authBrand.brandName);
  const usesNativeLogoImage = authBrand.brandName === "Okou";

  return {
    theme: "simple",
    options: {
      elevation: "raised",
      logoImageUrl: usesNativeLogoImage
        ? logoImageUrl
        : transparentClerkLogoImageUrl(authBrand.brandName),
      logoLinkUrl: authBrand.homeUrl,
      logoPlacement: "inside",
      socialButtonsPlacement: "top",
      socialButtonsVariant: "blockButton",
    },
    elements: {
      rootBox: "mx-auto w-full max-w-[25rem]",
      cardBox: cn(cardClassName, "w-full shadow-none"),
      card: "w-full rounded-none border-0 bg-card px-10 py-8 shadow-none",
      header: "items-center p-0 text-center",
      ...(usesNativeLogoImage
        ? {
            logoBox: "mb-5 self-center",
            logoImage: "block h-5 w-auto",
          }
        : {
            logoBox: {
              alignSelf: "center",
              backgroundImage: `url("${logoImageUrl}")`,
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              backgroundSize: "contain",
              height: "calc(var(--spacing) * 5)",
              marginBottom: "calc(var(--spacing) * 5)",
              padding: 0,
              width: "fit-content",
            },
            logoImage: "block h-full w-auto opacity-0",
          }),
      headerTitle: "text-lg font-medium leading-7 text-foreground",
      headerSubtitle: "mt-1 text-sm leading-5 text-muted-foreground",
      main: "m-0 gap-6",
      socialButtonsRoot: "m-0",
      socialButtons: "grid grid-cols-1 gap-2 sm:grid-cols-2",
      socialButtonsBlockButton: authV1SocialActionClass,
      socialButtonsBlockButtonText: "text-foreground",
      lastAuthenticationStrategyBadge:
        "rounded-md border border-border bg-card px-1.5 py-0.5 okou-auth-badge-text font-medium text-muted-foreground shadow-sm",
      dividerRow: "m-0 gap-4",
      dividerLine: "bg-border",
      dividerText: "text-sm text-muted-foreground",
      form: "gap-8",
      formFieldRow: "gap-2",
      formField: "gap-2",
      formFieldLabel: "text-sm font-medium leading-5 text-foreground",
      formFieldInput: cn(inputClassName, "shadow-none"),
      formFieldInput__password:
        "font-mono tracking-wider placeholder:font-sans placeholder:tracking-normal",
      formFieldInputShowPasswordButton: authV1PasswordToggleClass,
      formFieldInputShowPasswordIcon: "size-4",
      formButtonPrimary: authV1PrimaryActionClass,
      formButtonReset: AUTH_LINK_ACTION_CLASS,
      formFieldErrorText: "text-sm text-destructive",
      formFieldHintText: "text-sm text-muted-foreground",
      formFieldInfoText: "text-sm text-muted-foreground",
      formFieldSuccessText: "text-sm text-foreground",
      alertText: "text-sm text-foreground",
      identityPreview: "rounded-lg border border-border bg-muted/50",
      identityPreviewText: "text-foreground",
      identityPreviewEditButton: authV1IdentityPreviewEditClass,
      formResendCodeLink: AUTH_LINK_ACTION_CLASS,
      otpCodeFieldInputs: "gap-2",
      otpCodeFieldInput: authV1OtpInputClass,
      alternativeMethods: "gap-2",
      alternativeMethodsBlockButton: cn(
        authV1OutlineActionClass,
        "justify-between",
      ),
      alternativeMethodsBlockButtonText: "text-foreground",
      backLink: AUTH_LINK_ACTION_CLASS,
      footer: "m-0 gap-0 bg-card p-0",
      footerAction: "text-sm",
      footerAction__signIn: cn(
        "w-full justify-center border-t border-border px-10 py-4",
        AUTH_LINK_ACTION_CLASS,
      ),
      footerActionText: "text-foreground",
      footerActionLink:
        "text-inherit no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      footerAction__usePasskey: authV1OutlineActionClass,
      footerPages: "border-t border-border bg-card",
      footerPagesLink: AUTH_LINK_ACTION_CLASS,
      passkeyIcon__firstFactor: "size-4",
      formFieldCheckboxInput:
        "size-4 shrink-0 rounded-md border border-border bg-input shadow-none accent-primary",
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
