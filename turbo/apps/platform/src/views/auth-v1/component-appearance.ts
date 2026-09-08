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
import {
  AUTH_ERROR_ALERT_CLASS,
  AUTH_ERROR_ALERT_TEXT_CLASS,
  AUTH_FIELD_INPUT_CLASS,
  AUTH_LINK_ACTION_CLASS,
  AUTH_PRIMARY_ACTION_CLASS,
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
const authV1PrimaryActionClass = cn(
  buttonVariants({ size: "default", variant: "default" }),
  AUTH_PRIMARY_ACTION_CLASS,
  "w-full okou-auth-action-text shadow-none",
);
const authV1OtpInputClass = cn(
  inputClassName,
  AUTH_FIELD_INPUT_CLASS,
  "h-9 w-9 p-0 text-center text-base font-medium uppercase",
);
const authV1CheckboxInputClass =
  "size-4 shrink-0 rounded-md border border-border bg-input shadow-none accent-primary transition-colors outline-none checked:border-primary checked:bg-primary checked:before:bg-on-filled focus-visible:ring-2 focus-visible:ring-ring";
const authV1SignOutCheckboxInputClass = cn(
  authV1CheckboxInputClass,
  "mt-0.5 min-h-4 min-w-4 max-h-4 max-w-4 [--okou-input-padding-block:0] [--okou-input-padding-inline:0]",
);
const authV1CheckboxLabelClass =
  "text-sm font-medium leading-5 text-foreground";
const authV1SignOutCheckboxLabelClass = cn(
  authV1CheckboxLabelClass,
  "ms-1.5 min-w-0 flex-1 cursor-pointer p-0 text-left",
);
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
  "p-0",
);
const authV1BackLinkClass = cn(
  "mx-auto h-auto w-fit p-0 text-sm leading-5",
  AUTH_LINK_ACTION_CLASS,
);
const authV1ResendCodeLinkClass = cn(
  "h-auto p-0 okou-auth-action-text",
  AUTH_LINK_ACTION_CLASS,
);

// Clerk always adds `crossorigin="anonymous"` to its logo image. The public
// static host only grants that native image path to app.okou.ai; previews and
// the dormant VM0 surface retain the self-contained fallback.
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
  const logoImageUrl = authV1LogoImageUrl(theme, authBrand.brandName);
  const usesNativeLogoImage =
    authBrand.brandName === "Okou" && currentOrigin === "https://app.okou.ai";

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
      rootBox: "mx-auto w-full max-w-[var(--okou-auth-card-max-width)]",
      cardBox: cn(cardClassName, "w-full shadow-none"),
      card: "m-0 w-full rounded-none border-0 bg-card px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-padding-block)] shadow-none",
      header: "grid w-full grid-cols-1 items-center gap-0 p-0 text-center",
      ...(usesNativeLogoImage
        ? {
            logoBox: "mb-[var(--okou-auth-card-logo-gap)] justify-self-center",
            logoImage: "block h-[var(--okou-auth-card-logo-height)] w-auto",
          }
        : {
            logoBox: {
              alignSelf: "center",
              backgroundImage: `url("${logoImageUrl}")`,
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              backgroundSize: "contain",
              height: "var(--okou-auth-card-logo-height)",
              justifySelf: "center",
              marginBottom: "var(--okou-auth-card-logo-gap)",
              padding: 0,
              width: "fit-content",
            },
            logoImage: "block h-full w-auto opacity-0",
          }),
      headerTitle:
        "w-full max-w-none text-lg font-medium leading-7 text-foreground",
      headerSubtitle:
        "w-full max-w-none text-sm leading-5 text-muted-foreground",
      main: "m-0 gap-6",
      socialButtonsRoot: "m-0",
      socialButtons: "grid grid-cols-1 gap-2 sm:grid-cols-2",
      socialButtonsBlockButton: authV1SocialActionClass,
      socialButtonsBlockButtonText: "text-foreground",
      lastAuthenticationStrategyBadge:
        "rounded-md border border-border bg-card px-1.5 py-0.5 okou-auth-badge-text font-medium text-muted-foreground shadow-sm",
      dividerRow: "m-0 flex items-center gap-3",
      dividerLine: "h-px flex-1 bg-border",
      dividerText: "m-0 text-sm leading-5 text-muted-foreground",
      form: "gap-8",
      formFieldRow: "gap-2",
      formField: "gap-0",
      formFieldLabel: "text-sm font-medium leading-5 text-foreground",
      formFieldInput: cn(inputClassName, AUTH_FIELD_INPUT_CLASS, "shadow-none"),
      formFieldInput__password: authV1PasswordInputClass,
      formFieldInput__confirmPassword: authV1PasswordInputClass,
      formFieldInput__currentPassword: authV1PasswordInputClass,
      formFieldInput__newPassword: authV1PasswordInputClass,
      // Clerk renders this native checkbox through the generic formFieldInput
      // slot and paints its checked glyph with ::before. The shared padding
      // tokens and semantic checked-state utilities keep the public modifier
      // aligned with the shared Checkbox without specificity overrides.
      formFieldInput__signOutOfOtherSessions: authV1SignOutCheckboxInputClass,
      // This state exposes Clerk's public base radio-label element rather than
      // a field modifier. Its logical start margin reproduces the shared
      // Checkbox gap without selecting Clerk's anonymous wrapper.
      formFieldRadioLabel: authV1SignOutCheckboxLabelClass,
      formFieldInputShowPasswordButton: authV1PasswordToggleClass,
      formFieldInputShowPasswordIcon: "size-4",
      formButtonPrimary: authV1PrimaryActionClass,
      // Clerk 6.12 renders this public reset control without visible copy or an
      // accessible name. Removing the inert control is the only supported way
      // to keep it out of the tab order; appearance cannot add an aria-label.
      formButtonReset: "hidden",
      // Field feedback is text, not an Alert container. Clerk positions and
      // measures it to allocate space below the input. Container positioning,
      // borders, and padding break that contract, especially for OTP errors.
      formFieldErrorText: AUTH_ERROR_ALERT_TEXT_CLASS,
      formFieldHintText: "mt-2 text-sm leading-5 text-muted-foreground",
      formFieldInfoText: "mt-2 text-sm leading-5 text-muted-foreground",
      formFieldSuccessText: "mt-2 text-sm leading-5 text-foreground",
      alert: AUTH_ERROR_ALERT_CLASS,
      alertText: AUTH_ERROR_ALERT_TEXT_CLASS,
      identityPreview:
        "flex min-h-6 w-full items-center justify-center gap-2 text-sm leading-5 text-muted-foreground",
      identityPreviewText: "min-w-0 flex-1 truncate text-center",
      identityPreviewEditButton: authV1IdentityPreviewEditClass,
      // AuthV2 sign-up exposes the resend action across the form width, while
      // sign-in keeps its compact link geometry. Clerk's public element is
      // shared across states, so scope the width at the route appearance.
      formResendCodeLink: cn(
        authV1ResendCodeLinkClass,
        mode === "sign-up" ? "w-full" : "w-fit",
      ),
      otpCodeFieldInputs: "gap-2",
      otpCodeFieldInput: authV1OtpInputClass,
      otpCodeFieldErrorText: AUTH_ERROR_ALERT_TEXT_CLASS,
      alternativeMethods: "gap-2",
      alternativeMethodsBlockButton: cn(
        authV1OutlineActionClass,
        "justify-between",
      ),
      alternativeMethodsBlockButtonText: "text-foreground",
      backLink: authV1BackLinkClass,
      footer: "m-0 gap-0 bg-card p-0",
      footerAction: "text-sm text-muted-foreground",
      footerAction__signIn:
        "flex w-full items-center justify-center border-t border-border px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-footer-padding-block)]",
      footerAction__signUp:
        "flex w-full items-center justify-center border-t border-border px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-footer-padding-block)]",
      footerActionText: "text-inherit leading-5",
      footerActionLink: cn(
        "text-sm font-medium leading-5 underline underline-offset-4",
        AUTH_LINK_ACTION_CLASS,
      ),
      footerAction__usePasskey: authV1OutlineActionClass,
      footerPages: "border-t border-border bg-card",
      footerPagesLink: AUTH_LINK_ACTION_CLASS,
      passkeyIcon__firstFactor: "size-4",
      formFieldCheckboxInput: authV1CheckboxInputClass,
      formFieldCheckboxLabel: authV1CheckboxLabelClass,
    },
  };
}
