import { cardClassName, cn } from "@okouai/ui";
import type { SignIn } from "@clerk/react";
import type { ComponentProps } from "react";
import { platformOkouWordmarkLightImg } from "../../lib/static-assets.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

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
      logoBox: "mb-5 h-auto",
      logoImage: "h-auto w-[76px]",
    },
  };
}
