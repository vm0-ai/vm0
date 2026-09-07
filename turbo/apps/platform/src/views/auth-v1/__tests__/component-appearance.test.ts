import { buttonVariants, cardClassName, inputClassName } from "@okouai/ui";
import { expect, test } from "vitest";

import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
  platformVm0LogoDarkImg,
} from "../../../lib/static-assets.ts";
import {
  AUTH_ERROR_ALERT_CLASS,
  AUTH_ERROR_ALERT_TEXT_CLASS,
  AUTH_FIELD_INPUT_CLASS,
  AUTH_LINK_ACTION_CLASS,
  AUTH_PRIMARY_ACTION_CLASS,
  AUTH_SOCIAL_ACTION_CLASS,
} from "../../auth/auth-action-styles.ts";
import { getAuthV1ComponentAppearance } from "../component-appearance.ts";
import { getAuthV1ProviderAppearance } from "../provider-appearance.ts";

const OKOU_AUTH_BRAND = {
  brandName: "Okou",
  homeUrl: "https://app.okou.ai",
} as const;

function elementClasses(
  appearance: ReturnType<typeof getAuthV1ComponentAppearance>,
  key: string,
): string {
  const element = (
    appearance.elements as Record<string, unknown> | undefined
  )?.[key];
  if (typeof element !== "string") {
    throw new Error(`Expected ${key} to use Tailwind classes`);
  }
  return element;
}

function elementStyles(
  appearance: ReturnType<typeof getAuthV1ComponentAppearance>,
  key: string,
): Record<string, unknown> {
  const element = (
    appearance.elements as Record<string, unknown> | undefined
  )?.[key];
  if (!element || typeof element !== "object") {
    throw new Error(`Expected ${key} to use CSS-in-JS styles`);
  }
  return element as Record<string, unknown>;
}

test("Hosted auth uses Clerk's supported Tailwind customization surface", () => {
  const appearance = getAuthV1ComponentAppearance(
    "light",
    OKOU_AUTH_BRAND,
    "https://app.okou.ai",
  );

  expect(appearance.theme).toBe("simple");
  expect(appearance.options).toMatchObject({
    elevation: "raised",
    logoImageUrl: platformOkouWordmarkDarkImg,
    logoLinkUrl: OKOU_AUTH_BRAND.homeUrl,
    logoPlacement: "inside",
    socialButtonsPlacement: "top",
    socialButtonsVariant: "blockButton",
  });
  expect(elementClasses(appearance, "cardBox")).toContain(cardClassName);
  expect(elementClasses(appearance, "card")).toContain("m-0");
  expect(elementClasses(appearance, "formFieldInput")).toContain("h-9");
  expect(elementClasses(appearance, "formFieldInput")).toContain("rounded-lg");
  expect(elementClasses(appearance, "formFieldInput")).toContain(
    AUTH_FIELD_INPUT_CLASS,
  );
  expect(inputClassName).toContain("px-[var(--okou-input-padding-inline)]");
  expect(inputClassName).toContain("py-[var(--okou-input-padding-block)]");
  expect(elementClasses(appearance, "socialButtonsBlockButton")).toContain(
    AUTH_SOCIAL_ACTION_CLASS,
  );
  const primaryActionClasses = elementClasses(
    appearance,
    "formButtonPrimary",
  ).split(" ");
  expect(primaryActionClasses).toStrictEqual(
    expect.arrayContaining(
      buttonVariants({ size: "default", variant: "default" }).split(" "),
    ),
  );
  expect(primaryActionClasses).toStrictEqual(
    expect.arrayContaining(AUTH_PRIMARY_ACTION_CLASS.split(" ")),
  );
  expect(primaryActionClasses).toContain("okou-auth-action-text");
  expect(primaryActionClasses).toContain("border-0");
  expect(elementClasses(appearance, "formButtonReset")).toBe("hidden");
  for (const key of ["formFieldErrorText", "otpCodeFieldErrorText"]) {
    expect(elementClasses(appearance, key)).toContain(AUTH_ERROR_ALERT_CLASS);
    expect(elementClasses(appearance, key)).toContain(
      AUTH_ERROR_ALERT_TEXT_CLASS,
    );
    expect(elementClasses(appearance, key)).toContain("mt-2");
  }
  expect(elementClasses(appearance, "alert")).toBe(AUTH_ERROR_ALERT_CLASS);
  expect(elementClasses(appearance, "alertText")).toBe(
    AUTH_ERROR_ALERT_TEXT_CLASS,
  );
  expect(
    elementClasses(appearance, "lastAuthenticationStrategyBadge"),
  ).toContain("okou-auth-badge-text");
  expect(elementClasses(appearance, "header")).toContain("grid");
  expect(elementClasses(appearance, "header")).toContain("gap-0");
  expect(elementClasses(appearance, "headerTitle")).toContain("w-full");
  expect(elementClasses(appearance, "headerTitle")).toContain("max-w-none");
  expect(elementClasses(appearance, "headerSubtitle")).toContain("w-full");
  expect(elementClasses(appearance, "headerSubtitle")).toContain("max-w-none");
  expect(elementClasses(appearance, "logoBox")).toContain(
    "mb-[var(--okou-auth-card-logo-gap)]",
  );
  expect(elementClasses(appearance, "logoBox")).toContain(
    "justify-self-center",
  );
  expect(elementClasses(appearance, "logoImage")).toContain(
    "h-[var(--okou-auth-card-logo-height)]",
  );
  expect(elementClasses(appearance, "dividerRow")).toContain("gap-3");
  expect(elementClasses(appearance, "dividerText")).toContain("m-0");
  expect(elementClasses(appearance, "formField")).toContain("gap-0");
  expect(elementClasses(appearance, "otpCodeFieldInput")).toContain(
    AUTH_FIELD_INPUT_CLASS,
  );
  expect(elementClasses(appearance, "identityPreview")).toContain("min-h-6");
  expect(elementClasses(appearance, "formResendCodeLink")).toContain(
    "okou-auth-action-text",
  );
  expect(elementClasses(appearance, "backLink")).toContain("leading-5");
  expect(elementClasses(appearance, "footerAction")).toContain(
    "text-muted-foreground",
  );
  expect(elementClasses(appearance, "footerAction__signIn")).toContain(
    "items-center",
  );
  expect(elementClasses(appearance, "footerAction__signUp")).toContain(
    "items-center",
  );
  expect(elementClasses(appearance, "footerActionLink")).toContain(
    AUTH_LINK_ACTION_CLASS,
  );
  expect(elementClasses(appearance, "footerActionLink")).toContain("leading-5");
  expect(elementClasses(appearance, "footerAction__usePasskey")).toContain(
    "flex",
  );
  const checkboxInputClasses = elementClasses(
    appearance,
    "formFieldCheckboxInput",
  );
  expect(checkboxInputClasses).toContain("checked:border-primary");
  expect(checkboxInputClasses).toContain("checked:bg-primary");
  expect(checkboxInputClasses).toContain("checked:before:bg-on-filled");
  expect(checkboxInputClasses).toContain("focus-visible:ring-2");
  expect(elementClasses(appearance, "formFieldCheckboxLabel")).toContain(
    "leading-5",
  );
  const signOutCheckboxInputClasses = elementClasses(
    appearance,
    "formFieldInput__signOutOfOtherSessions",
  );
  expect(signOutCheckboxInputClasses).toContain("max-w-4");
  expect(signOutCheckboxInputClasses).toContain(
    "[--okou-input-padding-inline:0]",
  );
  expect(signOutCheckboxInputClasses).toContain(
    "[--okou-input-padding-block:0]",
  );
  expect(signOutCheckboxInputClasses).toContain("checked:border-primary");
  expect(signOutCheckboxInputClasses).toContain("checked:bg-primary");
  expect(signOutCheckboxInputClasses).toContain("checked:before:bg-on-filled");
  expect(signOutCheckboxInputClasses).toContain("focus-visible:ring-2");
  const signOutCheckboxLabelClasses = elementClasses(
    appearance,
    "formFieldRadioLabel",
  );
  expect(signOutCheckboxLabelClasses).toContain("ms-1.5");
  expect(signOutCheckboxLabelClasses).toContain("flex-1");
  expect(appearance.elements).not.toHaveProperty(
    "formFieldRadioLabel__signOutOfOtherSessions",
  );

  const serializedAppearance = JSON.stringify(appearance);
  expect(serializedAppearance).not.toContain("!important");
  expect(serializedAppearance).not.toContain("[class*=");
  expect(serializedAppearance).not.toContain("cl-internal-");
});

test("Hosted auth selects the theme-aware Okou logo", () => {
  expect(
    getAuthV1ComponentAppearance("dark", OKOU_AUTH_BRAND, "https://app.okou.ai")
      .options?.logoImageUrl,
  ).toBe(platformOkouWordmarkLightImg);
});

test("Preview origins retain the CORS-safe logo fallback", () => {
  const appearance = getAuthV1ComponentAppearance(
    "light",
    OKOU_AUTH_BRAND,
    "https://pr-32278-app-okou-app-preview.vm0.workers.dev",
  );

  expect(appearance.options?.logoImageUrl).toMatch(/^data:image\/svg\+xml,/u);
  expect(elementStyles(appearance, "logoBox").backgroundImage).toContain(
    platformOkouWordmarkDarkImg,
  );
  expect(elementStyles(appearance, "logoBox").justifySelf).toBe("center");
});

test("The dormant VM0 brand retains the CORS-safe logo fallback", () => {
  const appearance = getAuthV1ComponentAppearance(
    "light",
    {
      brandName: "VM0",
      homeUrl: "https://app.vm0.ai",
    },
    "https://app.vm0.ai",
  );

  expect(appearance.options?.logoImageUrl).toMatch(/^data:image\/svg\+xml,/u);
  expect(elementStyles(appearance, "logoBox").backgroundImage).toContain(
    platformVm0LogoDarkImg,
  );
});

test("The hosted auth provider exposes only design tokens below Tailwind utilities", () => {
  const appearance = getAuthV1ProviderAppearance();

  expect(appearance.cssLayerName).toBe("clerk");
  expect(appearance).not.toHaveProperty("elements");
  expect(appearance.variables).toMatchObject({
    borderRadius: "var(--radius-lg)",
    colorBackground: "hsl(var(--card))",
    colorPrimary: "hsl(var(--brand-text))",
    colorPrimaryForeground: "hsl(var(--brand-text-foreground))",
    fontFamily: "var(--font-family-sans)",
    fontSize: "var(--text-sm)",
  });
  const serializedAppearance = JSON.stringify(appearance);
  expect(serializedAppearance).not.toContain("!important");
  expect(serializedAppearance).not.toContain("[class*=");
  expect(serializedAppearance).not.toContain("cl-internal-");
});
