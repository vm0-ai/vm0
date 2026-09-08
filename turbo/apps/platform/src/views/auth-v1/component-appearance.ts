import {
  buttonVariants,
  cardClassName,
  checkboxVisualClassName,
  cn,
  inputClassName,
} from "@okouai/ui";
import type { SignIn } from "@clerk/react";
import type { ComponentProps, CSSProperties } from "react";

import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
} from "../../lib/static-assets.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";
import {
  AUTH_ERROR_ALERT_CLASS,
  AUTH_ERROR_ALERT_TEXT_CLASS,
  AUTH_FIELD_INPUT_CLASS,
  AUTH_LINK_ACTION_CLASS,
  AUTH_SOCIAL_ACTION_CLASS,
} from "../auth/auth-action-styles.ts";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;
type AuthV1ComponentMode = "sign-in" | "sign-up";

const authV1OutlineActionClass = cn(
  buttonVariants({ size: "default", variant: "outline" }),
  "w-full py-0 shadow-none",
);
const authV1SocialActionClass = cn(
  authV1OutlineActionClass,
  AUTH_SOCIAL_ACTION_CLASS,
);
// OTP slots are visual divs, not shared Input components. Clerk's accessible
// textbox owns typing, paste and retry; these public state attributes paint it.
const authV1OtpInputClass =
  "relative flex size-9 items-center justify-center rounded-lg border border-border bg-input p-0 text-center text-base font-medium text-foreground shadow-none data-[focus-within=true]:border-primary data-[focus-within=true]:ring-[3px] data-[focus-within=true]:ring-primary/10 aria-invalid:border-destructive data-[focus-within=true]:aria-invalid:border-destructive";
// Only the visual base is shared. Clerk retains its native checked/disabled
// state and ::before indicator, while Base UI retains its own state contract.
const authV1CheckboxInputClass = cn(
  checkboxVisualClassName,
  "shadow-none accent-primary checked:border-primary checked:bg-primary checked:before:bg-on-filled disabled:cursor-not-allowed disabled:opacity-50",
);
const authV1SignOutCheckboxInputClass = cn(
  authV1CheckboxInputClass,
  "mt-0.5 min-h-4 min-w-4 max-h-4 max-w-4 [--okou-input-padding-block:0] [--okou-input-padding-inline:0]",
);
const authV1CheckboxLabelClass =
  "text-sm font-medium leading-5 text-foreground";
// Clerk owns the reveal state. Reserve the trailing control's space in both
// states, and apply the shared Input's password typography only while hidden.
const authV1PasswordInputClass =
  "pe-10 [&[type=password]]:font-mono [&[type=password]]:tracking-wider placeholder:font-sans placeholder:tracking-normal";
const authV1PasswordToggleClass = cn(
  buttonVariants({ size: "icon", variant: "ghost" }),
  "inset-y-0 end-0 p-0 text-foreground before:inset-0",
);
const authV1IdentityPreviewEditClass = cn(
  buttonVariants({ size: "icon-2xs", variant: "quiet" }),
  "shrink-0 p-0 no-underline hover:no-underline",
);
const authV1TextActionClass = cn(
  AUTH_LINK_ACTION_CLASS,
  "no-underline hover:no-underline ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
);
const authV1BackLinkClass = cn(
  "mx-auto h-auto w-fit p-0 text-sm leading-5",
  authV1TextActionClass,
);
const authV1ResendCodeLinkClass = cn(
  "h-auto p-0 text-action",
  authV1TextActionClass,
);

// Clerk always adds `crossorigin="anonymous"` to its logo image. The public
// static host only grants that native image path to app.okou.ai; previews
// retain the self-contained fallback without broadening that CORS boundary.
function transparentClerkLogoImageUrl(): string {
  const { width, height } = { width: 1934, height: 512 };
  return `data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27${width}%27 height=%27${height}%27 viewBox=%270 0 ${width} ${height}%27%3E%3C/svg%3E`;
}

function authV1LogoImageUrl(theme: "light" | "dark"): string {
  return theme === "dark"
    ? platformOkouWordmarkLightImg
    : platformOkouWordmarkDarkImg;
}

function authV1LogoElements(
  logoImageUrl: string,
  usesNativeLogoImage: boolean,
): { logoBox: string | CSSProperties; logoImage: string } {
  if (usesNativeLogoImage) {
    return {
      logoBox: "m-0 self-center justify-self-center",
      logoImage: "block h-[var(--okou-auth-card-logo-height)] w-auto",
    };
  }
  return {
    logoBox: {
      alignSelf: "center",
      backgroundImage: `url("${logoImageUrl}")`,
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundSize: "contain",
      height: "var(--okou-auth-card-logo-height)",
      justifySelf: "center",
      margin: 0,
      padding: 0,
      width: "fit-content",
    },
    logoImage: "block h-full w-auto opacity-0",
  };
}

/**
 * Hosted authentication uses Clerk's supported customization stack: a simple
 * base theme, layout options, semantic tokens, and public appearance element
 * keys. Tailwind utilities win through the provider-level Clerk CSS layer
 * instead of specificity overrides.
 */
export function getAuthV1ComponentAppearance(
  theme: "light" | "dark",
  authBrand: AuthBrandContext,
  currentOrigin: string,
  mode: AuthV1ComponentMode,
): ClerkAppearance {
  const logoImageUrl = authV1LogoImageUrl(theme);
  const usesNativeLogoImage = currentOrigin === "https://app.okou.ai";

  return {
    theme: "simple",
    options: {
      elevation: "raised",
      logoImageUrl: usesNativeLogoImage
        ? logoImageUrl
        : transparentClerkLogoImageUrl(),
      logoLinkUrl: authBrand.homeUrl,
      // Card.Root renders an outside logo on every step; inside headers omit
      // it during verification. This supported option keeps branding coherent.
      logoPlacement: "outside",
      socialButtonsPlacement: "top",
      socialButtonsVariant: "blockButton",
    },
    elements: {
      rootBox:
        "okou-clerk-root mx-auto flex w-full max-w-[var(--okou-auth-card-max-width)] flex-col gap-[var(--okou-auth-card-logo-gap)]",
      button: "okou-clerk-button",
      cardBox: cn(cardClassName, "w-full shadow-none"),
      card: "m-0 w-full rounded-none border-0 bg-card px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-padding-block)] shadow-none",
      header: "grid w-full grid-cols-1 items-center gap-0 p-0 text-center",
      ...authV1LogoElements(logoImageUrl, usesNativeLogoImage),
      headerTitle:
        "w-full max-w-none text-lg font-medium leading-7 text-foreground",
      headerSubtitle:
        "w-full max-w-none text-sm leading-5 text-muted-foreground",
      main: "m-0 gap-6 has-[.cl-otpCodeField]:gap-8",
      socialButtonsRoot: "m-0",
      socialButtons: "grid grid-cols-1 gap-2 sm:grid-cols-2",
      socialButtonsBlockButton: authV1SocialActionClass,
      socialButtonsBlockButtonText: "text-foreground",
      lastAuthenticationStrategyBadge:
        "rounded-md border border-border bg-card px-1.5 py-0.5 text-badge font-medium text-muted-foreground shadow-sm",
      dividerRow: "m-0 flex items-center gap-3",
      dividerLine: "h-px flex-1 bg-border",
      dividerText: "m-0 text-sm leading-5 text-muted-foreground",
      form: "gap-8 has-[.cl-otpCodeField]:gap-2",
      formFieldRow: "gap-2",
      formField: "gap-0",
      formFieldLabel: "text-sm font-medium leading-5 text-foreground",
      formFieldInput: cn(
        inputClassName,
        AUTH_FIELD_INPUT_CLASS,
        "shadow-none aria-invalid:border-destructive aria-invalid:focus:border-destructive",
      ),
      formFieldInput__password: authV1PasswordInputClass,
      formFieldInput__confirmPassword: authV1PasswordInputClass,
      formFieldInput__currentPassword: authV1PasswordInputClass,
      formFieldInput__newPassword: authV1PasswordInputClass,
      // This native checkbox also receives the generic input slot. Keep its
      // dimensions and padding separate from text/password inputs.
      formFieldInput__signOutOfOtherSessions: authV1SignOutCheckboxInputClass,
      // The base label also serves real radio groups. Keep its native layout
      // and limit this adapter to typography shared by both kinds of field.
      formFieldRadioLabel: authV1CheckboxLabelClass,
      formFieldInputShowPasswordButton: authV1PasswordToggleClass,
      formFieldInputShowPasswordIcon: "size-4",
      formFieldAction: authV1TextActionClass,
      // UI 1.26.0 can omit this action's label on verification cards. Keep an
      // empty, unnamed action out of the tab order, but preserve labeled Back
      // controls in other flows or after a provider fix. Appearance cannot add
      // an accessible label; this provider limitation remains in the QA ledger.
      formButtonReset: cn(
        buttonVariants({ variant: "ghost" }),
        authV1TextActionClass,
        "w-full empty:hidden",
      ),
      // Field feedback is text, not an Alert container. Clerk positions and
      // measures it to allocate space below the input. Container positioning,
      // borders, and padding break that contract, especially for OTP errors.
      formFieldErrorText: AUTH_ERROR_ALERT_TEXT_CLASS,
      formFieldHintText: "text-xs leading-4 text-muted-foreground",
      formFieldInfoText: "text-xs leading-4 text-muted-foreground",
      formFieldWarningText: "text-xs leading-4",
      formFieldSuccessText: "text-xs leading-4 text-foreground",
      alert: AUTH_ERROR_ALERT_CLASS,
      alertText: AUTH_ERROR_ALERT_TEXT_CLASS,
      identityPreview:
        "flex min-h-6 w-full items-center justify-center gap-2 text-sm leading-5 text-muted-foreground",
      identityPreviewText: "min-w-0 truncate text-center",
      identityPreviewEditButton: authV1IdentityPreviewEditClass,
      identityPreviewEditButtonIcon: "size-4",
      // AuthV2 sign-up exposes the resend action across the form width, while
      // sign-in keeps its compact link geometry. Clerk's public element is
      // shared across states, so scope the width at the route appearance.
      formResendCodeLink: cn(
        authV1ResendCodeLinkClass,
        mode === "sign-up" ? "w-full" : "w-fit",
      ),
      otpCodeFieldInputs: "gap-2",
      otpCodeFieldInputs__loading: "opacity-50",
      otpCodeFieldInput: authV1OtpInputClass,
      otpCodeFieldErrorText: AUTH_ERROR_ALERT_TEXT_CLASS,
      alternativeMethods: "gap-2",
      // The same slot is a solid primary action for recovery and an outline
      // choice elsewhere. The button adapter preserves Clerk's variant.
      alternativeMethodsBlockButton:
        "w-full data-[variant=outline]:justify-start",
      alternativeMethodsBlockButtonText: "text-left text-foreground",
      alternativeMethodsBlockButtonArrow:
        "ms-auto transform-none opacity-100 rtl:-scale-x-100",
      backLink: authV1BackLinkClass,
      footer: "m-0 gap-0 bg-card p-0",
      footerAction: "text-sm text-muted-foreground",
      footerAction__signIn:
        "flex w-full items-center justify-center border-t border-border px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-footer-padding-block)]",
      footerAction__signUp:
        "flex w-full items-center justify-center border-t border-border px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-footer-padding-block)]",
      footerActionText: "text-inherit leading-5",
      footerActionLink: "okou-clerk-footer-link",
      footerAction__usePasskey: "w-full",
      footerPages: "border-t border-border bg-card",
      footerPagesLink: cn(
        authV1TextActionClass,
        "underline underline-offset-4 hover:underline",
      ),
      passkeyIcon__firstFactor: "size-4",
      formFieldCheckboxInput: authV1CheckboxInputClass,
      formFieldCheckboxLabel: authV1CheckboxLabelClass,
    },
  };
}
