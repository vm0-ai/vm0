import { cardClassName, cn } from "@okouai/ui";
import type { SignIn } from "@clerk/react";
import type { ComponentProps } from "react";
import { platformOkouWordmarkLightImg } from "../../lib/static-assets.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

const AUTH_V1_PRIMARY_ACTION_CLASS =
  "border-transparent bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed";

// Clerk's OTP slots are visual divs; its accessible textbox owns focus. Match
// the shared Input boundary while adapting focus and error states through the
// public attributes that Clerk exposes on each slot.
const AUTH_V1_OTP_INPUT_CLASS =
  "border-[0.7px] border-[hsl(var(--gray-400))] bg-input shadow-none data-[focus-within=true]:border-primary data-[focus-within=true]:ring-[3px] data-[focus-within=true]:ring-primary/10 aria-invalid:border-destructive data-[focus-within=true]:aria-invalid:border-destructive";

/** Keep branding and the page shell; Clerk owns control styles and states. */
export function getAuthV1ComponentAppearance(
  authBrand: AuthBrandContext,
  theme: "light" | "dark",
): ClerkAppearance {
  return {
    theme: "simple",
    options: {
      elevation: "raised",
      logoImageUrl: theme === "dark" ? platformOkouWordmarkLightImg : undefined,
      logoLinkUrl: authBrand.homeUrl,
      socialButtonsPlacement: "top",
      socialButtonsVariant: "blockButton",
    },
    elements: {
      rootBox:
        "mx-auto flex w-full max-w-[var(--okou-auth-card-max-width)] flex-col",
      cardBox: cn(cardClassName, "w-full shadow-none"),
      card: "m-0 w-full rounded-none border-0 bg-card px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-padding-block)] shadow-none",
      // Clerk owns the header rhythm; only the wordmark keeps its brand width.
      logoImage: "h-auto w-[76px]",
      // Clerk shares colorPrimary between links and filled controls. Keep the
      // accessible link color at provider level, then give only the CTA the
      // application's semantic filled-action colors.
      formButtonPrimary: AUTH_V1_PRIMARY_ACTION_CLASS,
      otpCodeFieldInput: AUTH_V1_OTP_INPUT_CLASS,
    },
  };
}
