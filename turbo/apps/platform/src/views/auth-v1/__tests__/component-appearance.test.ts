import { buttonVariants, cardClassName, inputClassName } from "@okouai/ui";
import { expect, test } from "vitest";

import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
  platformVm0LogoDarkImg,
} from "../../../lib/static-assets.ts";
import {
  getAuthV1LegacyComponentAppearance,
  getAuthV1SignInAppearance,
} from "../component-appearance.ts";
import { getAuthV1ProviderAppearance } from "../provider-appearance.ts";

const OKOU_AUTH_BRAND = {
  brandName: "Okou",
  homeUrl: "https://app.okou.ai",
} as const;

function elementClasses(
  appearance: ReturnType<typeof getAuthV1SignInAppearance>,
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
  appearance: ReturnType<typeof getAuthV1SignInAppearance>,
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

test("Hosted sign-in uses Clerk's supported Tailwind customization surface", () => {
  const appearance = getAuthV1SignInAppearance(
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
  expect(elementClasses(appearance, "formFieldInput")).toContain(
    inputClassName,
  );
  expect(elementClasses(appearance, "formButtonPrimary")).toContain(
    buttonVariants({ size: "default", variant: "default" }),
  );
  expect(elementClasses(appearance, "formButtonPrimary")).toContain(
    "okou-auth-action-text",
  );
  expect(
    elementClasses(appearance, "lastAuthenticationStrategyBadge"),
  ).toContain("okou-auth-badge-text");
  expect(elementClasses(appearance, "logoBox")).toContain("mb-5");
  expect(elementClasses(appearance, "logoImage")).toContain("h-5");
  expect(elementClasses(appearance, "footerAction__signIn")).toContain(
    "text-brand-text",
  );
  expect(elementClasses(appearance, "footerAction__usePasskey")).toContain(
    "flex",
  );

  const serializedAppearance = JSON.stringify(appearance);
  expect(serializedAppearance).not.toContain("!important");
  expect(serializedAppearance).not.toContain("[class*=");
  expect(serializedAppearance).not.toContain("cl-internal-");
});

test("Hosted sign-in selects the theme-aware Okou logo", () => {
  expect(
    getAuthV1SignInAppearance("dark", OKOU_AUTH_BRAND, "https://app.okou.ai")
      .options?.logoImageUrl,
  ).toBe(platformOkouWordmarkLightImg);
});

test("Preview origins retain the CORS-safe logo fallback", () => {
  const appearance = getAuthV1SignInAppearance(
    "light",
    OKOU_AUTH_BRAND,
    "https://pr-32278-app-okou-app-preview.vm0.workers.dev",
  );

  expect(appearance.options?.logoImageUrl).toMatch(/^data:image\/svg\+xml/u);
  expect(elementStyles(appearance, "logoBox").backgroundImage).toContain(
    platformOkouWordmarkDarkImg,
  );
});

test("The dormant VM0 brand retains the CORS-safe logo fallback", () => {
  const appearance = getAuthV1SignInAppearance(
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

test("The sign-in provider exposes only design tokens below Tailwind utilities", () => {
  const appearance = getAuthV1ProviderAppearance();

  expect(appearance.cssLayerName).toBe("clerk");
  expect(appearance).not.toHaveProperty("elements");
  expect(appearance.variables).toMatchObject({
    borderRadius: "var(--radius-lg)",
    colorBackground: "hsl(var(--card))",
    colorPrimary: "hsl(var(--primary))",
    fontFamily: "var(--font-family-sans)",
    fontSize: "var(--text-sm)",
  });
});

test("Sign-up remains on the legacy appearance during the sign-in migration", () => {
  expect(
    getAuthV1LegacyComponentAppearance("light", "Okou").options?.logoPlacement,
  ).toBe("none");
});
